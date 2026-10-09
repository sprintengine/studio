// The files a conversation's agent is reading and editing, folded off its
// event stream: what the Files tree marks while the agent works. The runtime
// keeps the fold on the session and ships it in the summary, so the tree can
// follow every chat in a workspace without subscribing to any of their event
// streams.

import type {
  ConversationEvent,
  ConversationFileActivity,
  ConversationJsonValue,
  ConversationToolKind,
} from '../conversation-runtime'

/**
 * How long a finished call is kept on the session. The tree lets a mark go
 * well before this (`AGENT_TRAIL_LINGER_MS`); the margin is for a summary read
 * a little late, not a second clock.
 */
export const FILE_ACTIVITY_RETAIN_MS = 60_000

/** At most this many calls are kept. A run of reads is the agent moving on. */
export const FILE_ACTIVITY_LIMIT = 16

const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// An absolute path, `/`-separated with `.` and `..` resolved; a relative one
// is read against the root the agent runs in. Null for anything that cannot be
// placed: `~`, a NUL, a climb above the root of the disk.
function placePath(raw: string, root: string): string | null {
  if (raw.includes('\0') || raw.startsWith('~')) return null
  const absolute = /^(?:\/|[A-Za-z]:[\\/])/u.test(raw) ? raw : `${root.replace(/[\\/]+$/u, '')}/${raw}`
  const path = absolute.replace(/\\/gu, '/')
  const prefix = path.startsWith('/') ? '/' : path.slice(0, 3)
  const parts: string[] = []
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return prefix + parts.join('/')
}

function namedPath(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = text(input[key])
    if (value) return value
  }
  return undefined
}

/**
 * What a tool call does to which files: `reading` or `editing`, and every path
 * it names. A call names its file at the top (`file_path`, a notebook's
 * `notebook_path`), per edit (`edits[].path`, a patch across files, and the
 * `movePath` a moved file lands at), or in the locations an ACP agent lists
 * beside it. Null for a call that is not a read or an edit, or names no file.
 */
export function fileActivityOf(
  kind: ConversationToolKind | undefined,
  name: string,
  input: ConversationJsonValue | undefined,
  root: string,
): { verb: ConversationFileActivity['verb']; paths: string[] } | null {
  const notebook = /^notebook[-_]?edit$/iu.test(name)
  const verb =
    kind === 'file_edit' || kind === 'file_write' || notebook ? 'editing' : kind === 'file_read' ? 'reading' : null
  if (!verb) return null
  const fields = record(input)
  const raws: string[] = []
  const top = namedPath(fields)
  if (top) raws.push(top)
  if (Array.isArray(fields.edits))
    for (const edit of fields.edits) {
      const entry = record(edit)
      const path = namedPath(entry)
      if (path) raws.push(path)
      const moved = text(entry.movePath)
      if (moved) raws.push(moved)
    }
  if (Array.isArray(fields.locations))
    for (const location of fields.locations) {
      const path = namedPath(record(location))
      if (path) raws.push(path)
    }
  const paths = [...new Set(raws.map((raw) => placePath(raw, root)).filter((path): path is string => path !== null))]
  return paths.length > 0 ? { verb, paths } : null
}

function toolCallId(payload: Record<string, unknown>): string | undefined {
  return text(payload.toolUseId) ?? text(payload.callId) ?? text(payload.id) ?? text(payload.toolCallId)
}

// Finished calls past the retention, then the oldest finished ones past the
// cap. A running call is never dropped for room: it is what the tree is for.
function prune(list: ConversationFileActivity[], now: number): ConversationFileActivity[] {
  const kept = list.filter((entry) => entry.endedAt === undefined || now - entry.endedAt < FILE_ACTIVITY_RETAIN_MS)
  let excess = kept.length - FILE_ACTIVITY_LIMIT
  if (excess <= 0) return kept
  return kept.filter((entry) => {
    if (excess > 0 && entry.endedAt !== undefined) {
      excess -= 1
      return false
    }
    return true
  })
}

/**
 * The session's file activity after one event, or null when the event leaves
 * it as it was. A read or edit starting adds one entry per path; its final
 * output (not a streamed `partial`) ends them; the turn ending ends whatever
 * of the conversation's own it left open. A background agent's steps carry on
 * past the turn, and end on their own output.
 */
export function applyFileActivityEvent(
  list: readonly ConversationFileActivity[],
  event: ConversationEvent,
  root: string,
): ConversationFileActivity[] | null {
  const payload = record(event.payload)
  const at = event.createdAt > 0 ? event.createdAt : Date.now()
  if (event.type === 'tool_started') {
    const id = toolCallId(payload)
    const activity = id
      ? fileActivityOf(
          payload.kind as ConversationToolKind | undefined,
          text(payload.name) ?? text(payload.tool) ?? '',
          payload.input as ConversationJsonValue | undefined,
          root,
        )
      : null
    if (!id || !activity) return null
    const laneId = text(payload.parentToolUseId)
    const started = activity.paths.map((path): ConversationFileActivity => ({
      path,
      verb: activity.verb,
      toolUseId: id,
      ...(laneId ? { laneId } : {}),
      startedAt: at,
    }))
    // The same call announced again (a provider that restates its input once
    // it has all of it) replaces what it said the first time.
    return prune([...list.filter((entry) => entry.toolUseId !== id), ...started], at)
  }
  if (event.type === 'tool_output' && payload.partial !== true) {
    const id = toolCallId(payload)
    if (!id || !list.some((entry) => entry.toolUseId === id && entry.endedAt === undefined)) return null
    return prune(
      list.map((entry) => (entry.toolUseId === id && entry.endedAt === undefined ? { ...entry, endedAt: at } : entry)),
      at,
    )
  }
  if ((event.type === 'turn_completed' && payload.steered !== true) || event.type === 'turn_failed') {
    if (!list.some((entry) => entry.endedAt === undefined && !entry.laneId)) return null
    return prune(
      list.map((entry) => (entry.endedAt === undefined && !entry.laneId ? { ...entry, endedAt: at } : entry)),
      at,
    )
  }
  return null
}
