#!/usr/bin/env node
// Multicode authoritative-agent-state reporter for OpenCode.
//
// Unlike Claude Code / Codex — which run an external command per lifecycle event
// and pipe a JSON payload to its stdin — OpenCode has no command-hook mechanism.
// It auto-loads in-process JS plugins from .opencode/plugin/ and lets them
// subscribe to a typed event stream. So this reporter is an OpenCode *plugin*,
// not a stdin filter: it maps OpenCode events to the same agent-state phases and
// writes the same newline-delimited JSON frame to the Multicode agent-state
// socket that the .claude/.codex reporter writes, so the runtime ingestion is
// unchanged.
//
// Agent identity comes from the MULTICODE_* env the app injects at launch. The
// socket address prefers MULTICODE_AGENT_STATE_SOCKET from that same env — it
// is per-process, so the agent always reports to the instance that launched it.
// The install-time baked path (the quoted token below, replaced with the live
// path) is the fallback for sessions launched outside the app: the baked copy
// lives in the shared workspace root and is last-writer-wins across app
// instances, so it may point at another (possibly dead) instance's socket.
//
// This file is loaded by OpenCode's runtime, so it stays dependency-free and
// NEVER throws into the host. The CANONICAL event→phase mapping lives in the
// opencode plugin manifest's agentStateSpec.events table, applied by the main
// process to the raw `event` each frame carries; the mapping below only decides
// which OpenCode events this plugin reports and dedups on, and the `phase` it
// sends is consulted solely when no manifest entry resolves the event. Keep the
// two aligned — drift here costs dedup granularity, not truth.

import { connect } from 'node:net'
import { isAbsolute, resolve as resolvePath } from 'node:path'

// Replaced with the live socket path (as a JSON string literal) at install time.
// Left as the raw token only if the file was copied without substitution.
const BAKED_SOCKET = '__MULTICODE_AGENT_STATE_SOCKET__'
// Reconstructed by concatenation so the install-time replacer (a plain replace
// of the quoted token) can never rewrite this guard value.
const RAW_TOKEN = '__MULTICODE' + '_AGENT_STATE_SOCKET__'
const CONNECT_TIMEOUT_MS = 1000
// Bounded retry, mirroring multicode-agent-state.mjs: a transiently busy
// listener must not eat a frame (a lost final `idle` parks the agent as
// working until the reap policy's stalled-expiry backstop). Capped by
// attempts AND an absolute deadline; a dead socket fails fast. Duplicate
// delivery is harmless (identical phase/ts re-ingest is a no-op).
const WRITE_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 200
const TOTAL_DEADLINE_MS = 2000

function resolveSocketPath() {
  if (process.env.MULTICODE_AGENT_STATE_SOCKET) return process.env.MULTICODE_AGENT_STATE_SOCKET
  if (BAKED_SOCKET && BAKED_SOCKET !== RAW_TOKEN) return BAKED_SOCKET
  return null
}

// See the canonical-mapping note in the header: this decides what is reported
// and deduped, while the manifest's events table decides the applied phase.
function mapEventToPhase(type) {
  switch (type) {
    case 'session.created':
      return 'starting'
    case 'message.updated':
      return 'thinking'
    case 'permission.updated':
      return 'awaiting_input'
    case 'permission.replied':
      return 'thinking'
    case 'session.idle':
    case 'session.error':
      return 'idle'
    default:
      return null
  }
}

// Extract the OpenCode session id from an event payload. Events carry it
// differently: most as `properties.sessionID`; session.* lifecycle events as
// `properties.info.id` (a Session); message.updated as `properties.info.sessionID`
// (a Message). The id is optional for the runtime (frames resolve by agentId),
// so an unknown shape returns null safely.
function sessionIdFromEvent(event) {
  const props = event && event.properties
  if (!props || typeof props !== 'object') return null
  if (typeof props.sessionID === 'string' && props.sessionID) return props.sessionID
  const info = props.info
  if (info && typeof info === 'object') {
    if (typeof info.sessionID === 'string' && info.sessionID) return info.sessionID
    if (typeof info.id === 'string' && info.id) return info.id
  }
  return null
}

// =============================================================================
// File changes — what the agent's changelist ends up owning, line by line.
//
// The stdin reporter (resources/hooks/multicode-agent-state.mjs) reads Claude
// Code's `structuredPatch` OBJECTS. OpenCode hands its plugins a real unified
// diff as TEXT, and this file is loaded into OpenCode's own process, so it can
// import nothing from the app. The walk below is therefore the reporter's
// `deriveEdits` reimplemented over patch text — same rules, same output
// convention — and the two must stay in step.
//
// These are the shapes of the LATEST OpenCode (1.18.30, 2026-09-09), read off
// live `tool.execute.after` payloads. They are deliberately the only shapes
// read: there is no back-compat rung for an older spelling of a field, because
// there is no older OpenCode to keep working.
//
//   edit        input.args  { filePath (ABSOLUTE), oldString, newString }
//               output.metadata { diff, filediff: { file (ABSOLUTE), patch,
//                                 additions, deletions }, diagnostics }
//   write       input.args  { filePath (ABSOLUTE), content }
//               output.metadata { filepath (ABSOLUTE), exists, diagnostics }
//               — NO diff at all: a write is counted only when it CREATED the
//                 file (`exists: false`), where the content is the whole
//                 addition; an overwrite reports the path alone.
//   apply_patch output.metadata { diff, files: [{ filePath (ABSOLUTE),
//                                 relativePath, type, patch, additions,
//                                 deletions, movePath? }] }
//               — read out of the shipped 1.18.30 binary, not observed live:
//                 apply_patch is an OpenAI-provider tool and was not registered
//                 for the model the capture ran on.
//
// `tool.execute.after` is the ONLY hook that carries an edit: 1.18.30's whole
// plugin trigger list is tool.execute.before/after, chat.*, command.execute.
// before, file.open, shell.env, tab.new, tool.definition and the experimental.*
// transforms. The `file.edited` event is not read — its schema is `{ file }`
// and it is published by these same three tools, so it could only ever restate
// a claim this already makes with line numbers attached.
//
// Nothing here infers a count from a shape it has not seen: an unreadable diff
// forwards the PATH with no `edits` and no invented numbers, because a
// file-level claim is a smaller lie than a wrong line range.
// =============================================================================

const MAX_FILE_PATH_LENGTH = 4096
// Mirrors MAX_EDITS_PER_FRAME in the stdin reporter and MAX_FILE_CHANGE_EDITS
// in main: past this a call is a whole-file rewrite in all but name.
const MAX_EDITS_PER_FRAME = 200
// The file-writing tools 1.18.30 registers — `edit`, `write` and `apply_patch`
// are the whole list (the registry also holds read, glob, grep, todowrite,
// webfetch, skill, question, plan_exit, command, invalid, none of which write).
// A tool that is not in here is never guessed at: no ledger entry beats a wrong
// one, and `bash` writing a file through `sed` is not something this can read.
const FILE_EDIT_TOOL_NAMES = new Set(['edit', 'write', 'apply_patch'])
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * One unified diff → its counts and its MINIMAL changed regions.
 *
 * Hunk bounds are NOT the answer: `@@ -3,9 +3,9 @@` around a one-line change
 * claims nine lines the agent never touched, and in a file two agents share
 * those lines belong to whoever last wrote them. So each hunk is WALKED: a
 * context line advances both cursors and can never be inside an edit, a `-`
 * advances the old cursor, a `+` the new one, and a maximal run of `-`/`+` is
 * one edit. `\ No newline at end of file` is diff bookkeeping — it moves
 * neither cursor and does not break the run it trails.
 *
 * Output is in GIT's hunk convention: a run starts at its first line, and a
 * side with no lines is ANCHORED AFTER the preceding line (`-12,2 +11,0` is
 * "old lines 12-13 deleted after new line 11"). The same convention is why a
 * header whose side reads zero (`@@ -0,0 +1,3 @@`, a created file) starts its
 * cursor one line later than the header says — the number is an anchor there,
 * not the first line of a run.
 *
 * The hunk is consumed by its declared LINE COUNTS rather than by looking for
 * the next header, because a deleted line of text can itself begin `---` and a
 * header-sniffing parser would cut the hunk short there.
 *
 * Returns null when the text carries no readable hunk (a header-only patch, a
 * `Binary files … differ` stub, a truncated blob) — the caller then forwards
 * the path with no ranges.
 */
function readUnifiedDiff(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return null
  // `\r?\n` so a patch delivered with CRLF separators reads the same as one
  // with LF; only the first character of each line is ever consulted, so a
  // CRLF-ending content line loses nothing that matters here.
  const lines = patch.split(/\r?\n/)
  const edits = []
  let additions = 0
  let deletions = 0
  let sawHunk = false
  let index = 0
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index])
    index += 1
    if (!header) continue
    const oldStart = Number(header[1])
    // An omitted count is git's shorthand for exactly one line.
    const oldLines = header[2] === undefined ? 1 : Number(header[2])
    const newStart = Number(header[3])
    const newLines = header[4] === undefined ? 1 : Number(header[4])
    if (![oldStart, oldLines, newStart, newLines].every((n) => Number.isSafeInteger(n) && n >= 0)) return null
    sawHunk = true
    let oldCursor = oldLines === 0 ? oldStart + 1 : oldStart
    let newCursor = newLines === 0 ? newStart + 1 : newStart
    let oldLeft = oldLines
    let newLeft = newLines
    let runOld = 0
    let runNew = 0
    let runOldAt = oldCursor
    let runNewAt = newCursor
    const openRun = () => {
      if (runOld === 0 && runNew === 0) {
        runOldAt = oldCursor
        runNewAt = newCursor
      }
    }
    const flush = () => {
      if (runOld === 0 && runNew === 0) return
      edits.push({
        oldStart: runOld > 0 ? runOldAt : Math.max(0, runOldAt - 1),
        oldLines: runOld,
        newStart: runNew > 0 ? runNewAt : Math.max(0, runNewAt - 1),
        newLines: runNew,
      })
      runOld = 0
      runNew = 0
    }
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = lines[index]
      // A new header inside a hunk means the declared counts lied; stop rather
      // than swallow the next hunk's body.
      if (HUNK_HEADER.test(line)) break
      index += 1
      if (line.startsWith('\\')) continue
      if (line.startsWith('-')) {
        openRun()
        runOld += 1
        deletions += 1
        oldCursor += 1
        oldLeft -= 1
        continue
      }
      if (line.startsWith('+')) {
        openRun()
        runNew += 1
        additions += 1
        newCursor += 1
        newLeft -= 1
        continue
      }
      // Context — ' ', and the bare empty line some producers write for a blank
      // context line. It ends the run and steps both sides.
      flush()
      oldCursor += 1
      newCursor += 1
      oldLeft -= 1
      newLeft -= 1
    }
    flush()
    if (edits.length >= MAX_EDITS_PER_FRAME) {
      return { additions, deletions, edits: edits.slice(0, MAX_EDITS_PER_FRAME) }
    }
  }
  return sawHunk ? { additions, deletions, edits } : null
}

// A path the app can hand a person to open: absolute, bounded. OpenCode reports
// `filePath` absolute but `relativePath` relative to the worktree, so a relative
// value is resolved against the session's own directory — the only cwd this
// process can honestly claim. No directory and a relative path ⇒ nothing.
function toAbsolutePath(raw, directory) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  const absolute = isAbsolute(value) ? value : directory ? resolvePath(directory, value) : null
  if (!absolute || absolute.length > MAX_FILE_PATH_LENGTH) return null
  return absolute
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// A reported count is used only when it is a real, finite, non-negative number.
// Anything else falls back to the walk over the patch, and if there is no patch
// either the change is still reported as 0/0 — the file WAS edited.
function readCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

// A file's whole content is its addition when the file did not exist before.
// A trailing newline does not make a last empty line.
function countContentLines(content) {
  if (typeof content !== 'string' || content.length === 0) return 0
  return content.replace(/\r?\n$/, '').split('\n').length
}

function buildFileChange(rawPath, directory, { patch, additions, deletions, createdContent } = {}) {
  const path = toAbsolutePath(rawPath, directory)
  if (!path) return null
  const walked = readUnifiedDiff(patch)
  const change = {
    path,
    additions: readCount(additions) ?? walked?.additions ?? 0,
    deletions: readCount(deletions) ?? walked?.deletions ?? 0,
  }
  if (walked && walked.edits.length > 0) {
    change.edits = walked.edits
    return change
  }
  // No readable patch, but the tool told us the file did not exist: git spells a
  // whole-file creation `@@ -0,0 +1,N @@`, and `-0,0` is the anchor before the
  // first line of a file that was not there.
  if (typeof createdContent === 'string') {
    const lines = countContentLines(createdContent)
    change.additions = readCount(additions) ?? lines
    if (lines > 0) change.edits = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines }]
  }
  return change
}

/**
 * The file changes one `tool.execute.after` describes — one entry per file, so
 * a multi-file apply_patch becomes one frame per file.
 *
 * Three rungs, in the order the payload offers them: `metadata.files` (the
 * apply_patch shape, one patch per file), `metadata.filediff` (edit), and the
 * path alone (write, and anything whose diff would not parse). The last rung
 * is deliberate: "this file was touched" is worth more than nothing, and a
 * file-level claim is what the changelist falls back to.
 */
function deriveFileChanges(toolName, args, output, directory) {
  const tool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  if (!FILE_EDIT_TOOL_NAMES.has(tool)) return []
  const result = isPlainObject(output) ? output : {}
  const metadata = isPlainObject(result.metadata) ? result.metadata : {}
  const input = isPlainObject(args) ? args : {}
  const changes = []
  const seen = new Set()
  const add = (change) => {
    if (!change || seen.has(change.path)) return
    seen.add(change.path)
    changes.push(change)
  }

  // apply_patch: every touched file, each with its own patch. A move reports
  // the DESTINATION — that is where the content now lives, and it is what
  // OpenCode itself treats as the edited file.
  if (Array.isArray(metadata.files)) {
    for (const entry of metadata.files) {
      if (!isPlainObject(entry)) continue
      add(
        buildFileChange(entry.movePath ?? entry.filePath, directory, {
          patch: entry.patch,
          additions: entry.additions,
          deletions: entry.deletions,
        })
      )
    }
    if (changes.length > 0) return changes
  }

  // edit. `filediff.file` is absolute in the payload; it is still resolved
  // against the session directory, because an absolute path is what main
  // ACCEPTS (`parseFrameFileChange` drops a relative one and with it the whole
  // ledger entry) and the tool's own `filePath` is the backstop when the
  // filediff is malformed enough to have lost its file.
  const filediff = isPlainObject(metadata.filediff) ? metadata.filediff : null
  if (filediff) {
    add(
      buildFileChange(filediff.file ?? input.filePath, directory, {
        patch: filediff.patch,
        additions: filediff.additions,
        deletions: filediff.deletions,
      })
    )
    if (changes.length > 0) return changes
  }

  // write, and any payload whose richer shape did not survive. `metadata.
  // filepath` is write's own echo of the resolved path; `args.filePath` is what
  // the model asked for.
  add(
    buildFileChange(metadata.filepath ?? input.filePath, directory, {
      // A write that CREATED the file: `exists: false` and the content it was
      // given. An overwrite (`exists: true`) has no diff anywhere in the
      // payload, so it stays a file-level claim rather than a guessed count.
      createdContent: metadata.exists === false ? input.content : undefined,
    })
  )
  return changes
}

// `frames` is a LIST: an apply_patch that rewrote six files is six frames, and
// they go down ONE connection rather than six, because this runs inside the
// tool call OpenCode is waiting on.
function writeFrameOnce(socketPath, frames) {
  return new Promise((res) => {
    let settled = false
    const done = (delivered) => {
      if (settled) return
      settled = true
      res(delivered)
    }
    let socket
    try {
      socket = connect(socketPath)
    } catch {
      done(false)
      return
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.on('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      socket.write(frames.map((frame) => JSON.stringify(frame) + '\n').join(''), () => socket.end())
    })
    socket.on('close', () => done(true))
  })
}

async function writeFrame(socketPath, frames) {
  const startedAt = Date.now()
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (await writeFrameOnce(socketPath, frames)) return
    if (Date.now() - startedAt + RETRY_BACKOFF_MS >= TOTAL_DEADLINE_MS) return
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
  }
}

// Captured once, then frozen. `opencode run` is one process = one root session
// (the session `--continue` resumes); the runtime persists the reported id as
// the resume target. Sub-agent sessions OpenCode creates later carry their own
// ids — reporting those would let the last one overwrite the root and make
// resume target the wrong session. So we lock the FIRST session id we see (the
// root) and stamp it on every frame thereafter.
let lockedSessionId = null
// Dedup consecutive identical EVENTS — OpenCode emits `message.updated` on
// every streamed delta (dozens/sec), so without this a turn would open one
// socket per delta. The key is the EVENT name, not the mapped phase: turn
// semantics live on the event (the manifest flags `session.error` as a failed
// turn while it shares `session.idle`'s phase), so a `session.idle` followed
// by `session.error` must both reach main — a phase-keyed dedup would eat the
// failure. The runtime's stall watch reads live output, not this cadence, so
// a quiet `thinking` is still caught.
let lastEvent = null
// The directory OpenCode was launched in, from the plugin context (MC-2440).
// OpenCode never changes its working directory mid-session, so stamping the
// launch directory on every frame is an honest observation for the session's
// whole life — it is what lets the app notice a session launched by hand into
// a worktree it did not create.
let launchDirectory = null

async function report(phase, event, sessionId, fileChanges = []) {
  if (!phase) return
  // Seed the lock before the dedup early-return, so the root id is captured even
  // from a frame we suppress (the first frame, `starting`, is never a dup).
  if (sessionId && !lockedSessionId) lockedSessionId = sessionId
  // A call CARRYING file changes is never a duplicate: two edits in a row share
  // the `tool.execute.after` event name but describe different files, and the
  // dedup exists to throttle streamed deltas, not to drop the ledger. The phase
  // it repeats is idempotent on re-ingest, so the extra frames are free.
  if (event === lastEvent && fileChanges.length === 0) return
  lastEvent = event
  const socketPath = resolveSocketPath()
  if (!socketPath) return
  const agentId = process.env.MULTICODE_AGENT_ID
  if (!agentId) return
  const frame = {
    type: 'agent_state',
    agentId,
    workspaceId: process.env.MULTICODE_WORKSPACE_ID || null,
    sessionId: lockedSessionId,
    phase,
    event: event || null,
    ts: Date.now(),
  }
  if (launchDirectory) frame.cwd = launchDirectory
  // One frame per changed FILE (an apply_patch can rewrite several in one
  // call), all carrying the identical event and ts so the phase fold stays
  // idempotent and the ledger reads each file once. No file change: the phase
  // frame still goes, exactly as before.
  const frames =
    fileChanges.length > 0 ? fileChanges.map((fileChange) => ({ ...frame, fileChange })) : [frame]
  await writeFrame(socketPath, frames)
}

// OpenCode plugin entrypoint: an exported async function returning a hooks
// object. The generic `event` hook receives the typed lifecycle event stream;
// `tool.execute.before/after` are separate named hooks (not part of that stream)
// and give the tool_use phase, mirroring Claude's PreToolUse/PostToolUse split.
export const MulticodeAgentState = async (context) => {
  // `directory` is the session's working directory in OpenCode's plugin
  // context (its `worktree` is the git root, which is the derived fact the app
  // computes itself). Older builds may pass no context: the frame then carries
  // no cwd and the app keeps launch intent.
  const directory = context && typeof context.directory === 'string' ? context.directory.trim() : ''
  if (directory) launchDirectory = directory
  return {
    event: async ({ event }) => {
      try {
        const type = event && typeof event.type === 'string' ? event.type : null
        if (!type) return
        const phase = mapEventToPhase(type)
        if (!phase) return
        await report(phase, type, sessionIdFromEvent(event))
      } catch {
        // Never let a reporter error break OpenCode.
      }
    },
    'tool.execute.before': async (input) => {
      try {
        const sessionId = input && typeof input.sessionID === 'string' ? input.sessionID : null
        await report('tool_use', 'tool.execute.before', sessionId)
      } catch {
        // Never let a reporter error break OpenCode.
      }
    },
    // OpenCode calls this with the call's INPUT (`{ tool, sessionID, callID,
    // args }`) and the tool's RESULT (`{ title, output, metadata }`) as two
    // arguments — verified live against opencode 1.18.30. The result is where
    // the file change lives; a tool that THREW never reaches this hook, so a
    // reported change is always a change that landed.
    'tool.execute.after': async (input, output) => {
      try {
        const sessionId = input && typeof input.sessionID === 'string' ? input.sessionID : null
        // Derived defensively and separately from the phase: a payload shape
        // this cannot read must still cost nothing but the ledger entry.
        let changes = []
        try {
          changes = deriveFileChanges(input?.tool, input?.args, output, launchDirectory)
        } catch {
          changes = []
        }
        await report('thinking', 'tool.execute.after', sessionId, changes)
      } catch {
        // Never let a reporter error break OpenCode.
      }
    },
  }
}
