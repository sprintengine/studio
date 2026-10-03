// Pull requests a CHAT agent opens, filed against its conversation (owner,
// 2026-10-02: "any agent who's gonna do some work should result in a pull
// request… we need to intercept that call on the conversational chat agent").
//
// The terminal agents already do this from their hook reporter
// (`resources/hooks/sprintengine-agent-state.mjs`, "Pull request capture"). A
// chat agent runs no hook reporter: its tool calls arrive here as conversation
// events instead, so this is the same capture read off the other stream, and
// it keeps the reporter's rules exactly:
//
// - ONE gate: a shell command containing `gh pr create`. `gh pr view` and
//   `gh pr list` print other pull requests' URLs and must not file them here.
// - The URL is read from the tool's OUTPUT only, never from its input — an
//   agent that merely typed a URL has not opened anything.
// - A failed call still counts: `gh pr create` exits non-zero when the branch
//   already has a pull request, and prints that pull request's URL.
//
// Filed by conversation only. A chat session's id is not a terminal session's,
// so there is no session to put it on; the conversation's row is what draws it
// (`useConversationPullRequests`), and the record files it under the URL's own
// repository and learns its branch from GitHub.

import type { ConversationEvent } from '../shared/conversation-runtime'
import { parsePullRequestUrl } from '../shared/git/pr-url'

/** `<host>/<owner>/<repo>/pull/<n>`. The reporter's regex; main's parser re-checks every match. */
const PULL_REQUEST_URL_RE =
  /https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+(?![\w])/

/** `gh pr create`, however the shell spaced it; `/usr/local/bin/gh pr create` matches, `gh pr list` never does. */
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/

const MAX_PULL_REQUEST_URL_LENGTH = 2048

/**
 * Tool calls waiting on their output. A call whose output never arrives (the
 * turn was stopped) would otherwise be held for the life of the process.
 */
const MAX_PENDING_CALLS = 200

/** Where a tool's text sits in an output payload, after the runtime has prepared it. */
const OUTPUT_TEXT_FIELDS = ['output', 'preview', 'stdout', 'stderr', 'content', 'text', 'result'] as const

export type ConversationPullRequestCaptureDeps = {
  onEvent(listener: (event: ConversationEvent) => void): () => void
  noteCaptured(input: { url: string; workspaceId: string }): void
}

/** Watch the conversation stream for `gh pr create`. Returns the unsubscribe. */
export function captureConversationPullRequests(deps: ConversationPullRequestCaptureDeps): () => void {
  // session + tool call → the conversation it belongs to, for the calls that
  // ran `gh pr create` and have not finished yet.
  const pending = new Map<string, string>()

  return deps.onEvent((event) => {
    const toolUseId = toolUseIdOf(event)
    if (!toolUseId || !event.workspaceId) return
    const key = `${event.sessionId}\0${toolUseId}`
    if (event.type === 'tool_started') {
      if (!isPullRequestCreation(event.payload?.input)) return
      if (pending.size >= MAX_PENDING_CALLS) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
      }
      pending.set(key, event.workspaceId)
      return
    }
    if (event.type !== 'tool_output' || event.payload?.partial === true) return
    const workspaceId = pending.get(key)
    if (!workspaceId) return
    pending.delete(key)
    const url = pullRequestUrlIn(event.payload)
    if (url) deps.noteCaptured({ url, workspaceId })
  })
}

function toolUseIdOf(event: ConversationEvent): string | null {
  const id = event.payload?.toolUseId ?? event.payload?.toolCallId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** The shell command a tool call ran: a string on Claude-style tools, an argv array on Codex's. */
export function toolCommandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  for (const candidate of [record.command, record.cmd, record.script]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (Array.isArray(candidate)) {
      const parts = candidate.filter((part): part is string => typeof part === 'string')
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return null
}

export function isPullRequestCreation(input: unknown): boolean {
  const command = toolCommandOf(input)
  return command !== null && GH_PR_CREATE_RE.test(command)
}

/** The first pull request URL a tool's output carries, bounded in depth like the reporter's. */
export function pullRequestUrlIn(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === 'string') return firstPullRequestUrl(value)
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) {
      const url = pullRequestUrlIn(entry, depth + 1)
      if (url) return url
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const field of OUTPUT_TEXT_FIELDS) {
    const url = pullRequestUrlIn(record[field], depth + 1)
    if (url) return url
  }
  return null
}

function firstPullRequestUrl(text: string): string | null {
  const match = PULL_REQUEST_URL_RE.exec(text)
  if (!match || match[0].length > MAX_PULL_REQUEST_URL_LENGTH) return null
  const parsed = parsePullRequestUrl(match[0])
  if (!parsed || 'unsupported' in parsed) return null
  return match[0]
}
