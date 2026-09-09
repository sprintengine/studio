#!/usr/bin/env node
// Multicode authoritative-agent-state reporter — the shared stdin filter for
// every command-hook CLI (Claude Code, Codex, Grok Build, and any CLI whose
// plugin manifest declares a command-hook agentStateSpec registration).
//
// This script is a DUMB FORWARDER: it reads the CLI's hook JSON from stdin —
// Claude Code and Codex name the fields snake_case (`hook_event_name`,
// `session_id`); Grok Build ships the same hook contract with camelCase names
// (`hookEventName`, `sessionId`), so every field is read under both spellings —
// and writes a single newline-delimited JSON frame carrying the RAW event name
// (plus the payload discriminator fields the manifests consult, e.g. Claude's
// `notification_type`) to the Multicode agent-state socket. The event→phase
// mapping happens in the main process from the resolving plugin manifest's
// `agentStateSpec.events` table — no CLI vocabulary lives in this script, so
// it never needs to change when a CLI's mapping does. Which events fire at all
// is decided by the hook REGISTRATION the app writes from that same manifest
// data. The agent's identity comes from the MULTICODE_* env the app injects at
// launch.
//
// Socket address resolution — env FIRST, arg as fallback:
//   MULTICODE_AGENT_STATE_SOCKET   Injected into the launch env by the app
//                     instance that spawned this agent. Wins because it is
//                     per-process and cannot be clobbered: the --socket arg
//                     below lives in the repo's shared settings.local.json,
//                     which is last-writer-wins across app instances, so it
//                     may point at another (possibly dead) instance's socket.
//   --socket <path>   Agent-state socket (unix domain socket / named pipe)
//                     baked in at install time. Fallback for sessions launched
//                     outside the app (no MULTICODE_* env).
//
// The script ALWAYS exits 0 and never blocks meaningfully: a reporter failure
// must never break or stall the agent.

import { connect } from 'node:net'

const CONNECT_TIMEOUT_MS = 1000
// Bounded retry: a transiently busy listener must not silently eat a frame —
// a lost `Stop` is the worst case (it is what makes a dormant agent
// reclaimable by the idle reaper; the reap policy's stalled-expiry is the
// backstop, but that costs ~17 extra minutes of held RAM). Retries are capped
// by attempts AND an absolute deadline so the hook still exits promptly; a
// permanently dead socket fails fast (connect error) and never waits out the
// full deadline.
const WRITE_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 200
const TOTAL_DEADLINE_MS = 2000
// Send-side cap on the forwarded prompt. Must stay <= MAX_AGENT_PROMPT_LENGTH in
// src/main/agent-state.ts, which truncates again on receipt — this reporter is
// untrusted input, so the cap here is a courtesy, not the enforcement.
const MAX_PROMPT_LENGTH = 2000
// Send-side cap on the forwarded cwd (MC-2440). Mirrors MAX_OBSERVED_CWD_LENGTH
// in src/shared/observed-checkout.ts; the reader re-validates (absolute, capped).
const MAX_CWD_LENGTH = 4096
// Send-side cap on a reported file path. Mirrors the reader's cap in
// src/main/agent-state.ts; an over-long value is DROPPED rather than sliced —
// half a path names the wrong file, and the reader would reject it anyway.
const MAX_FILE_PATH_LENGTH = 4096
// Send-side cap on the changed REGIONS forwarded per call (agent changelists).
// Mirrors MAX_FILE_CHANGE_EDITS in src/main/agent-state.ts. A call that rewrote
// more of a file than this is a whole-file rewrite in all but name; the first
// 200 regions are kept (they are ascending, so the ones that are kept are still
// correct) and the rest fall to the changelist model's remainder rule.
const MAX_EDITS_PER_FRAME = 200

/**
 * The MINIMAL changed regions of one tool call — what the agent's changelist
 * ends up owning line by line (`recordEdit` in src/shared/git/changelists.ts).
 *
 * NOT the hunk bounds. A structuredPatch hunk is padded with context lines on
 * both sides, so `@@ -1,7 +1,8 @@` around a one-line change would claim eight
 * lines the agent never touched — and in a file two agents share, those lines
 * belong to whoever last wrote them. So each hunk is WALKED: a context line
 * advances both cursors and can never be inside an edit; a `-` advances the old
 * cursor; a `+` advances the new one; and a maximal run of `-`/`+` lines is one
 * edit. A `\ No newline at end of file` marker is diff bookkeeping — it moves
 * neither cursor and does not break the run it trails.
 *
 * The output is in GIT's hunk convention, which is what the model reads: a run
 * starts at its first line, and a side with no lines is ANCHORED AFTER the
 * preceding line (`-4,0` = "inserted after old line 4", `+0,0` = "deleted before
 * the first new line"). The same convention is the reason a CONTEXT-FREE hunk
 * (`oldLines: 0` / `newLines: 0`, which only happens at context 0) has its
 * cursor started one line later than the header says: the header's number is an
 * anchor there, not the first line of a run.
 *
 * Unreadable shape → null, and the caller then forwards the path with no
 * `edits` at all: a file-level claim is a smaller lie than a wrong line range.
 */
function deriveEdits(hunks) {
  const edits = []
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== 'object') return null
    const { oldStart, oldLines, newStart, newLines, lines } = hunk
    if (!Number.isInteger(oldStart) || !Number.isInteger(newStart)) return null
    if (oldStart < 0 || newStart < 0) return null
    if (!Array.isArray(lines)) return null
    // A zero-length side is an anchor ("after this line"), so the first line of
    // the region it describes is the next one. `oldLines`/`newLines` are read
    // ONLY for that test — deliberately, so a CLI that omits them degrades to
    // the ordinary (context-carrying) reading rather than losing every range.
    let oldCursor = oldLines === 0 ? oldStart + 1 : oldStart
    let newCursor = newLines === 0 ? newStart + 1 : newStart
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
    for (const line of lines) {
      if (typeof line !== 'string') return null
      if (line.startsWith('\\')) continue
      if (line.startsWith('-')) {
        openRun()
        runOld += 1
        oldCursor += 1
        continue
      }
      if (line.startsWith('+')) {
        openRun()
        runNew += 1
        newCursor += 1
        continue
      }
      // Context (' ', and whatever an unchanged line is otherwise spelled as):
      // it ends the run and steps both sides.
      flush()
      oldCursor += 1
      newCursor += 1
    }
    flush()
    if (edits.length >= MAX_EDITS_PER_FRAME) return edits.slice(0, MAX_EDITS_PER_FRAME)
  }
  return edits
}

/**
 * Line counts for one file-editing tool call, read from the hook's
 * `tool_response` — which is the tool's own RESULT object, not a wrapper.
 *
 * Verified payloads (Claude Code, 2026-09-09):
 *   Edit   result keys: filePath, newString, oldString, originalFile,
 *                       replaceAll, structuredPatch, userModified
 *   Write  result keys: content, filePath, originalFile, structuredPatch,
 *                       type ('create' | 'update'), userModified
 *   structuredPatch: [{ oldStart, oldLines, newStart, newLines,
 *                       lines: [' unchanged', '+added', '-removed', …] }]
 *
 * A Write that CREATES a file carries an EMPTY structuredPatch (there is no
 * "before" to diff against), so its additions are the line count of `content`.
 *
 * MultiEdit and NotebookEdit fire the same hook. Their result shapes are NOT
 * verified here: if one carries a structuredPatch it is counted like the rest,
 * and otherwise the call is still recorded — path only, 0/0 — because "this
 * file was touched" is worth more than a guessed count. Nothing infers counts
 * from a shape this comment has not seen.
 *
 * A call that FAILED reports nothing. A tool error comes back as a string (or
 * an object carrying `error`), never as a result object, and a file the agent
 * failed to edit appearing in the ledger is exactly the wrong lie — worse than
 * the missing entry, because it is indistinguishable from a real edit whose
 * shape we could not count.
 *
 * Only the path, the two integers and the changed line RANGES (`deriveEdits`,
 * four ints each) ever ride the socket: the patch text and the file content stay
 * here (the frame line cap is 64KB, and a person's file contents are not ours to
 * forward).
 *
 * Pure, and deliberately NOT exported: importing this file runs `main()` and
 * exits the process. The counting is covered by spawning the script with real
 * hook payloads on stdin (src/main/agent-state-service.test.ts).
 */
function deriveFileChange(toolResponse, toolInput) {
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return null
  const response = toolResponse
  if (response.error || response.is_error) return null
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const text = (value) => (typeof value === 'string' ? value : null)
  const rawPath =
    text(response.filePath)
    ?? text(response.file_path)
    ?? text(input.file_path)
    ?? text(input.filePath)
    ?? text(input.notebook_path)
    ?? text(input.notebookPath)
  const path = rawPath?.trim()
  if (!path || path.length > MAX_FILE_PATH_LENGTH) return null

  let additions = 0
  let deletions = 0
  const hunks = Array.isArray(response.structuredPatch) ? response.structuredPatch : []
  for (const hunk of hunks) {
    const lines = hunk && typeof hunk === 'object' && Array.isArray(hunk.lines) ? hunk.lines : []
    for (const line of lines) {
      if (typeof line !== 'string') continue
      // Every hunk line is prefixed: ' ' context, '+' added, '-' removed.
      // A '\' line ("\ No newline at end of file") is diff bookkeeping, not a
      // line of the file, and counts as neither.
      if (line.startsWith('+')) additions += 1
      else if (line.startsWith('-')) deletions += 1
    }
  }
  // A created file has nothing to diff against, so the patch is empty and the
  // whole content is the addition. Taken from the result, or from the tool's
  // own input when the result echoes only the path — otherwise a brand-new
  // 300-line file would report as zero, which nobody could tell from a real
  // zero. A trailing newline does not make a last empty line, so it is not
  // counted as one.
  if (hunks.length === 0 && response.type === 'create') {
    const content = text(response.content) ?? text(input.content)
    if (content !== null) additions = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length
  }
  // The changed regions, for the agent's changelist. A created file is one
  // region: git spells a whole-file creation `@@ -0,0 +1,N @@`, and `-0,0` is
  // the anchor before the first line of a file that did not exist.
  const edits =
    hunks.length === 0 && response.type === 'create'
      ? additions > 0
        ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: additions }]
        : []
      : deriveEdits(hunks)
  // No regions at all (an empty create, a patch shape this could not read) means
  // no `edits` field: the app then claims the FILE rather than any line of it.
  return edits && edits.length > 0 ? { path, additions, deletions, edits } : { path, additions, deletions }
}

// The tools whose PostToolUse payload this reporter reads a file change out of.
// Claude Code's spelling; Codex, Kimi and Grok ship the same hook contract and
// the same `PostToolUse` event name, so a CLI of theirs that spells its editing
// tools this way is read too — one that does not simply never matches, which is
// the safe direction (no ledger beats a wrong one).
const FILE_EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function readStdin() {
  return new Promise((res) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => res(buf))
    process.stdin.on('error', () => res(buf))
    if (process.stdin.isTTY) res('')
  })
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--socket') {
      args.socket = argv[i + 1]
      i += 1
    }
  }
  return args
}

function writeFrameOnce(socketPath, frame) {
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
    socket.on('error', () => {
      done(false)
    })
    socket.on('connect', () => {
      socket.write(JSON.stringify(frame) + '\n', () => {
        socket.end()
      })
    })
    socket.on('close', () => done(true))
  })
}

// A duplicate delivery (write landed but the ack path errored, then a retry
// re-sent) is harmless: the runtime re-ingests the identical phase/ts, a no-op
// — so no send-side idempotency is needed. Total failure stays silent (exit 0).
async function writeFrame(socketPath, frame) {
  const startedAt = Date.now()
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (await writeFrameOnce(socketPath, frame)) return
    if (Date.now() - startedAt + RETRY_BACKOFF_MS >= TOTAL_DEADLINE_MS) return
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const socketPath = process.env.MULTICODE_AGENT_STATE_SOCKET || args.socket
  if (!socketPath) return

  const agentId = process.env.MULTICODE_AGENT_ID
  if (!agentId) return

  const stdinRaw = await readStdin()
  // Strip a leading UTF-8 BOM some shells prepend when piping a string.
  const stdin = stdinRaw.replace(/^﻿/, '')
  if (!stdin.trim()) return

  let payload
  try {
    payload = JSON.parse(stdin)
  } catch {
    return
  }

  // Claude Code / Codex use snake_case payload fields; Grok Build uses
  // camelCase for the same contract. Read both so one reporter serves all
  // stdin-filter CLIs. No phase is computed here — the frame carries the raw
  // event name and the main process maps it via the resolving plugin
  // manifest's agentStateSpec (an event the spec does not name simply drops).
  const str = (value) => (typeof value === 'string' ? value : null)
  const event = str(payload?.hook_event_name) ?? str(payload?.hookEventName)
  if (!event) return
  const notificationType = str(payload?.notification_type) ?? str(payload?.notificationType)

  const frame = {
    type: 'agent_state',
    agentId,
    workspaceId: process.env.MULTICODE_WORKSPACE_ID ?? null,
    // The CLI's own session identity, under its known spellings: session_id
    // (Claude/Codex/Kimi), sessionId (Grok), conversation_id (Cursor — its
    // chat id, which is what `--resume <chatId>` takes).
    sessionId: str(payload?.session_id) ?? str(payload?.sessionId) ?? str(payload?.conversation_id),
    event,
    ts: Date.now(),
  }
  // Payload discriminators the manifests consult: Claude's Notification
  // allow-list, and a turn-outcome status (Cursor's stop payload carries
  // status: completed|aborted|error). Forwarded verbatim under one spelling
  // each; the reader caps them.
  if (notificationType) frame.notificationType = notificationType
  const status = str(payload?.status)
  if (status) frame.status = status

  // The prompt the person just sent, forwarded on `UserPromptSubmit` only. The
  // app uses it for two things: the hover preview on a terminal tab ("what was I
  // working on here?"), and naming a new chat after its first real prompt
  // instead of leaving it "Chat 44".
  //
  // Truncated HERE rather than at the reader so a pasted novel never rides the
  // socket. The cap is generous relative to a title because the hover preview
  // shows more than the title does.
  //
  // This is the user's verbatim typed text. Context injected by other hooks is
  // added to the agent's context downstream and is NOT part of this field, so
  // the app never titles a chat after an injection — but text the APP itself
  // pasted into the terminal (a dropped skill invocation, a file path) IS part
  // of it, and is stripped by the reader (see src/shared/workspace-title.ts).
  // `UserPromptSubmit` is Claude/Codex/Kimi vocabulary; Cursor spells the same
  // moment `beforeSubmitPrompt`.
  if (event === 'UserPromptSubmit' || event === 'beforeSubmitPrompt') {
    const prompt = str(payload?.prompt) ?? str(payload?.userPrompt) ?? str(payload?.text)
    if (prompt) {
      const trimmed = prompt.trim()
      if (trimmed) frame.prompt = trimmed.slice(0, MAX_PROMPT_LENGTH)
    }
  }

  // The session transcript, forwarded on a turn end so the app can derive a
  // summary from the agent's closing message (an automation run's completion
  // summary). ONLY on turn-end events (`Stop`; Kimi's failed-turn
  // `StopFailure`; Cursor spells it `stop` and attaches transcript_path to
  // every hook): `SubagentStop` carries a transcript_path too, but it is a
  // subagent's, and a subagent finishing is not this session's turn end. The
  // path is passed through untouched: it is untrusted input, and the reader
  // owns containment (see transcriptPath in src/main/agent-state.ts).
  if (event === 'Stop' || event === 'stop' || event === 'StopFailure') {
    const transcriptPath = str(payload?.transcript_path) ?? str(payload?.transcriptPath)
    if (transcriptPath) frame.transcriptPath = transcriptPath
  }

  // Self-scheduled wakeup: the ScheduleWakeup tool arms a timer INSIDE the CLI
  // process (self-paced loops — "wake me in 20 minutes"). Between the schedule
  // and the firing the agent's phase is idle, which is exactly what the idle
  // reaper hunts — and killing the process silently cancels the timer. Report
  // the schedule (and the stop) so the app can hold the reaper until it fires.
  // Must mirror parseAgentStateFrame's wakeup validation in
  // src/main/agent-state.ts.
  const toolName = str(payload?.tool_name) ?? str(payload?.toolName)
  if (event === 'PostToolUse' && toolName === 'ScheduleWakeup') {
    const input = payload?.tool_input ?? payload?.toolInput
    if (input && typeof input === 'object') {
      if (input.stop === true) frame.wakeup = { stop: true }
      else if (typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds) && input.delaySeconds > 0) {
        frame.wakeup = { delaySeconds: input.delaySeconds }
      }
    }
  }

  // What the agent just changed on disk, forwarded on the PostToolUse of a
  // file-editing tool so the app can keep a per-session ledger ("this agent
  // touched 9 files, +240/-31") without asking git — git answers for the
  // CHECKOUT, which several agents and the person share. Counts are the hook's
  // own diff hunks, so they are cumulative by construction: a line edited twice
  // counts twice, which is the intent (they measure the agent's work, not the
  // tree's distance from HEAD).
  //
  // Deliberately NOT suppressed for a subagent (`agent_id` present, see the cwd
  // rule below): a subagent's edits belong to the session that spawned it. Only
  // the path and the two integers are forwarded — never the patch, never the
  // file content (the reader's frame line cap is 64KB).
  // `PostToolUse` is Claude/Codex/Kimi/Grok vocabulary. Cursor spells it
  // `postToolUse`, and is deliberately not read here: none of its tools are
  // named below, so accepting the spelling would only imply a support that the
  // payload cannot deliver.
  if (event === 'PostToolUse' && toolName && FILE_EDIT_TOOL_NAMES.has(toolName)) {
    const fileChange = deriveFileChange(
      payload?.tool_response ?? payload?.toolResponse,
      payload?.tool_input ?? payload?.toolInput
    )
    if (fileChange) frame.fileChange = fileChange
  }

  // Where the session IS (MC-2440): Claude Code, Codex and Grok put the
  // session's working directory on every hook payload. Forwarded verbatim (the
  // reader shape-checks it) so the app can resolve the checkout the agent is
  // actually working in — a worktree it created mid-run, or one it was
  // launched into by hand — instead of assuming the launch cwd forever. A cwd
  // only changes through a tool call, so the PostToolUse that follows carries
  // the new one; Claude's CwdChanged event (`new_cwd`) is read too in case a
  // registration for it ever fires, but the app registers no such event.
  // Absent on CLIs whose payloads carry no cwd (Cursor): the app then keeps
  // its launch intent.
  //
  // NOT forwarded from a subagent's hooks: Claude Code stamps `agent_id` on
  // every payload that fires from within a subagent (its own docs: "use this
  // field, not agent_type, to distinguish subagent calls from main-thread
  // calls"), and a subagent may run in an isolated worktree of its own — its
  // cwd is not where the session is, and forwarding it would bounce the tab
  // between the two per tool call. Codex names the same marker `agent_id`.
  //
  // Cursor is the exception: its base payload carries `workspace_roots`
  // (the directory cursor-agent was launched in) and its Shell tool adds a
  // per-command `cwd` — the `workingDirectory` of ONE command, not where the
  // session lives. Cursor has no persisted cd, so the launch root is the
  // honest session cwd (the same semantics as OpenCode's `directory`) and the
  // per-command value is ignored.
  const subagentId = str(payload?.agent_id) ?? str(payload?.agentId)
  const workspaceRoots = Array.isArray(payload?.workspace_roots) ? payload.workspace_roots : null
  const cwd = workspaceRoots
    ? str(workspaceRoots[0])
    : str(payload?.new_cwd) ?? str(payload?.newCwd) ?? str(payload?.cwd)
  if (cwd && !subagentId) {
    const trimmed = cwd.trim()
    if (trimmed && trimmed.length <= MAX_CWD_LENGTH) frame.cwd = trimmed
  }

  await writeFrame(socketPath, frame)
}

main()
  .catch(() => {
    // Never let a reporter error break Claude.
  })
  .finally(() => {
    process.exit(0)
  })
