#!/usr/bin/env node
// SprintEngine Studio authoritative-agent-state reporter — the shared stdin
// filter for every command-hook CLI (Claude Code, Codex, Grok Build, and any
// CLI whose plugin manifest declares a command-hook agentStateSpec registration).
//
// This script is a DUMB FORWARDER: it reads the CLI's hook JSON from stdin —
// Claude Code and Codex name the fields snake_case (`hook_event_name`,
// `session_id`); Grok Build ships the same hook contract with camelCase names
// (`hookEventName`, `sessionId`), so every field is read under both spellings —
// and writes newline-delimited JSON frames (one, except that one file-editing
// call can change several files and each rides its own frame) carrying the RAW event name
// (plus the payload discriminator fields the manifests consult, e.g. Claude's
// `notification_type`) to the studio's agent-state socket. The event→phase
// mapping happens in the main process from the resolving plugin manifest's
// `agentStateSpec.events` table — no CLI vocabulary lives in this script, so
// it never needs to change when a CLI's mapping does. Which events fire at all
// is decided by the hook REGISTRATION the app writes from that same manifest
// data. The agent's identity comes from the SPRINTENGINE_* env the app injects at
// launch.
//
// Socket address resolution — env FIRST, arg as fallback:
//   SPRINTENGINE_AGENT_STATE_SOCKET  Injected into the launch env by the app
//                     instance that spawned this agent. Wins because it is
//                     per-process and cannot be clobbered: the --socket arg
//                     below lives in the repo's shared settings.local.json,
//                     which is last-writer-wins across app instances, so it
//                     may point at another (possibly dead) instance's socket.
//   --socket <path>   Agent-state socket (unix domain socket / named pipe)
//                     baked in at install time. Fallback for sessions launched
//                     outside the app (no SPRINTENGINE_* env).
//
// The script ALWAYS exits 0 and never blocks meaningfully: a reporter failure
// must never break or stall the agent.

import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { isAbsolute, resolve as resolvePath } from 'node:path'

// The app's own variables answer to two names. Everything was spelled
// `MULTICODE_*` before the 2026-09-08 rename to SprintEngine Studio and is
// spelled `SPRINTENGINE_*` now, and this file is a COPY installed into a
// workspace: the app instance launching an agent may be either side of that
// rename, and this copy may be either side of it too. New name first, old name
// second. An empty value counts as unset here, matching the `||` fallbacks the
// call sites already had.
const studioEnv = (name) =>
  process.env[name] || process.env[name.replace(/^SPRINTENGINE_/, 'MULTICODE_')] || ''

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
// Send-side cap on a captured pull request URL (epic `pull-request-marks`).
// Mirrors MAX_PULL_REQUEST_URL_LENGTH in src/main/agent-state.ts. Over the cap
// the field is DROPPED rather than sliced — half a URL is a different pull
// request, and the reader would refuse it anyway.
// The CLI's own tool-call id is a short opaque token (Claude's `toolu_…` is 29
// chars). Longer than this is a payload anomaly and the id is dropped rather
// than truncated — a truncated id could collide with another call's.
const MAX_TOOL_USE_ID_LENGTH = 256

const MAX_PULL_REQUEST_URL_LENGTH = 2048
// How much of one tool result is scanned for that URL. The result itself is
// NEVER forwarded (the reader's frame line cap is 64KB); this only bounds the
// work a pathological response can cost. `gh pr create` prints the URL on its
// LAST line, so an over-long response is scanned at BOTH ends rather than
// truncated from the front — a head-only scan would miss every capture that
// followed a noisy push.
const MAX_PULL_REQUEST_SCAN_LENGTH = 64 * 1024

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
    const walked = walkHunkLines(lines, oldLines === 0 ? oldStart + 1 : oldStart, newLines === 0 ? newStart + 1 : newStart, edits)
    if (!walked) return null
    if (edits.length >= MAX_EDITS_PER_FRAME) return edits.slice(0, MAX_EDITS_PER_FRAME)
  }
  return edits
}

/**
 * Walk ONE hunk's prefixed lines from a known starting position on both sides,
 * pushing each maximal run of `-`/`+` lines onto `edits` as a minimal region in
 * git's convention. Shared by the structuredPatch reader above (which takes its
 * start from the hunk header) and the V4A patch reader below (which has no
 * header and takes its start from locating the hunk's post-image in the file).
 *
 * Returns the cursors it ended on plus the line counts it saw, or null when a
 * line is not a string (an unreadable shape, which costs the call its ranges).
 */
function walkHunkLines(lines, startOld, startNew, edits) {
  let oldCursor = startOld
  let newCursor = startNew
  let additions = 0
  let deletions = 0
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
      deletions += 1
      runOld += 1
      oldCursor += 1
      continue
    }
    if (line.startsWith('+')) {
      openRun()
      additions += 1
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
  return { oldCursor, newCursor, additions, deletions }
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

// ===========================================================================
// Cross-CLI file-edit extraction
//
// Claude Code hands the reporter a ready-made diff (`structuredPatch`, read
// above). No other CLI does: Codex sends the raw V4A patch TEXT it just
// applied, and Cursor/Kimi/Grok send the old/new STRINGS of a search-replace.
// None of them carries a line number.
//
// So the line numbers are recovered the only honest way available to a hook:
// read the file the CLI has just finished writing and find the post-image in
// it. A UNIQUE match is a line number; anything else (absent, or two copies of
// the same text) costs the call its ranges and leaves a file-level claim, which
// every consumer already falls back to. The file content NEVER leaves this
// process — only the four small integers per region do.
// ===========================================================================

// Cap on the file this script reads back to locate an edit. A hook must not
// stall a turn slurping a huge generated file, and a file that big is a
// file-level claim in all but name anyway.
const MAX_LOCATE_FILE_BYTES = 2 * 1024 * 1024

// The line count of a chunk of file text, in the sense a hunk header uses: how
// many lines the chunk OCCUPIES. One trailing newline terminates the last line
// rather than starting an empty one, and the empty string is zero lines — git's
// anchor, which is exactly what an empty `old_string` (a pure insertion) means.
function countTextLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.replace(/\n$/, '').split('\n').length
}

// CRLF is a line ENDING, not a line: normalizing both the file and the needle
// to \n leaves every line number unchanged and lets a \n-spelled tool argument
// match a \r\n file (and the reverse), which is the common Windows-checkout
// case. Done on copies; nothing is written back.
function normalizeNewlines(text) {
  return typeof text === 'string' && text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
}

// The file as it stands AFTER the tool call, or null (unreadable, a directory,
// or over the cap). Synchronous on purpose: this is a short-lived process whose
// whole job is one frame.
function readFileForLocate(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_LOCATE_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Where a block of post-edit text sits in the file, 1-based. `absent` and
// `ambiguous` are told apart because they mean different things about the CLI
// (one says the write did not land where we looked; the other that the text
// occurs twice) — but both cost the call its ranges: a range located at the
// WRONG copy of a repeated string hands another agent's lines to this one.
function locateBlock(haystack, needle) {
  if (typeof needle !== 'string' || needle.length === 0) return { kind: 'absent' }
  const first = haystack.indexOf(needle)
  if (first < 0) return { kind: 'absent' }
  if (haystack.indexOf(needle, first + 1) >= 0) return { kind: 'ambiguous' }
  let line = 1
  for (let i = 0; i < first; i += 1) if (haystack.charCodeAt(i) === 10) line += 1
  return { kind: 'found', start: line }
}

/**
 * One search-replace edit, located in the file it was just written into.
 *
 * The NEW text is what is on disk now, so it is what is searched for; the OLD
 * text is gone and only ever contributes its line COUNT. The returned
 * `oldStart` is provisional (it assumes nothing above this edit moved) —
 * `sequenceEdits` corrects it for the edits that landed above it in the same
 * call, which is the whole reason the two steps are separate.
 *
 * A deletion (empty new text) is unlocatable by construction and returns null:
 * there is nothing left in the file to find.
 */
function locateEdit(fileAfter, oldText, newText) {
  if (typeof fileAfter !== 'string') return null
  const found = locateBlock(normalizeNewlines(fileAfter), normalizeNewlines(newText))
  if (found.kind !== 'found') return null
  return {
    oldStart: found.start,
    oldLines: countTextLines(normalizeNewlines(typeof oldText === 'string' ? oldText : '')),
    newStart: found.start,
    newLines: countTextLines(normalizeNewlines(newText)),
  }
}

/**
 * Turn edits located INDEPENDENTLY in the final file into one call's worth of
 * git-convention regions.
 *
 * Every edit was found in the file as it is now, so its `newStart` is right and
 * its `oldStart` is not: an edit N lines below one that added three lines sat
 * three lines higher before the call. Sorting by new-side position and carrying
 * the running delta fixes that — and sorting is what makes it independent of
 * the order the CLI happened to apply them in, since an edit above another is
 * unaffected by it either way.
 *
 * `recordEdit` (src/shared/git/changelists.ts) walks these old-side coordinates
 * to move every OTHER agent's spans through this call, so an oldStart that is
 * off by a region silently mis-attributes their lines. Hence the correction.
 */
function sequenceEdits(located) {
  const sorted = [...located].sort((a, b) => a.newStart - b.newStart)
  const edits = []
  let delta = 0
  for (const edit of sorted) {
    const mapped = edit.newStart - delta
    // A zero-length old side is an anchor AFTER the preceding old line.
    const oldStart = edit.oldLines > 0 ? mapped : mapped - 1
    edits.push({
      oldStart: Math.max(0, oldStart),
      oldLines: edit.oldLines,
      newStart: edit.newStart,
      newLines: edit.newLines,
    })
    delta += edit.newLines - edit.oldLines
    if (edits.length >= MAX_EDITS_PER_FRAME) break
  }
  return edits
}

// A reported path, absolute. Codex's V4A paths are whatever the model wrote
// (`./src/x.ts` is legal), and the reader REQUIRES absolute — a relative path
// names nothing off the process that reported it. Resolved against the
// payload's own cwd, which is where the CLI ran the tool.
function absolutePath(raw, baseDir) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  const abs = isAbsolute(value) ? value : resolvePath(baseDir, value)
  return abs.length > MAX_FILE_PATH_LENGTH ? null : abs
}

// The directory a relative tool path resolves against: the session's own cwd
// (Claude/Codex/Kimi/Grok), Cursor's workspace root, else this process's cwd —
// which is the CLI's, since the hook is spawned as its child.
function payloadBaseDir(payload) {
  const roots = Array.isArray(payload?.workspace_roots) ? payload.workspace_roots : null
  const candidates = [
    typeof payload?.cwd === 'string' ? payload.cwd : null,
    typeof payload?.workspaceRoot === 'string' ? payload.workspaceRoot : null,
    roots && typeof roots[0] === 'string' ? roots[0] : null,
  ]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && isAbsolute(trimmed)) return trimmed
  }
  return process.cwd()
}

// ---------------------------------------------------------------------------
// Codex: the V4A patch text of an `apply_patch` call
//
// VERIFIED against codex-cli 0.153.3 (2026-09-09): `tool_name` is always
// `apply_patch`, `tool_input.command` holds the raw patch, `tool_response` is a
// STRING ("Exit code: 0\nWall time…\nOutput:\nSuccess. Updated the following
// files:\nA <path>\nM <path>"), and there are no line numbers anywhere. One
// call can carry several files, which is why extraction returns a LIST.
//
// Grammar (the subset a CLI emits): `*** Begin Patch`, then per file one of
// `*** Update File: p` (optionally followed by `*** Move to: q`), `*** Add
// File: p`, `*** Delete File: p`; then prefixed lines — ' ' context, '+' added,
// '-' removed — split into hunks by `@@` headers that carry a context hint and
// never a line number. `*** End Patch` ends it.
// ---------------------------------------------------------------------------
function parseV4APatch(text) {
  if (typeof text !== 'string' || !text.includes('*** Begin Patch')) return null
  const files = []
  let current = null
  const openFile = (verb, path) => {
    current = { verb, path, movePath: null, hunks: [] }
    files.push(current)
  }
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('*** ')) {
      if (line.startsWith('*** Update File: ')) openFile('update', line.slice('*** Update File: '.length).trim())
      else if (line.startsWith('*** Add File: ')) openFile('add', line.slice('*** Add File: '.length).trim())
      else if (line.startsWith('*** Delete File: ')) openFile('delete', line.slice('*** Delete File: '.length).trim())
      else if (line.startsWith('*** Move to: ') && current) current.movePath = line.slice('*** Move to: '.length).trim()
      // `*** Begin Patch` / `*** End Patch` / anything else: structural only.
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      // A new hunk. The header's context hint is not a line number and is not
      // read; an empty hunk is dropped so a header that opens nothing cannot
      // manufacture a region.
      current.hunks.push([])
      continue
    }
    if (current.hunks.length === 0) current.hunks.push([])
    current.hunks[current.hunks.length - 1].push(line)
  }
  return files.length > 0 ? files : null
}

// The post-image of a hunk: the lines the file HAS now, which is context plus
// additions with their one-character prefix removed. A '\' line is diff
// bookkeeping and belongs to neither image.
function hunkPostImage(lines) {
  const kept = []
  for (const line of lines) {
    if (line.startsWith('\\') || line.startsWith('-')) continue
    kept.push(line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line)
  }
  return kept
}

function deriveCodexFileChanges(patchText, baseDir) {
  const files = parseV4APatch(patchText)
  if (!files) return []
  const changes = []
  for (const file of files) {
    // A rename reports the file that exists afterwards: that is the one on
    // disk to locate hunks in, and the one a person can open.
    const path = absolutePath(file.movePath ?? file.path, baseDir)
    if (!path) continue
    if (file.verb === 'delete') {
      // Nothing left to count or locate. The path alone still says the agent
      // touched this file, which is the entry worth having.
      changes.push({ path, additions: 0, deletions: 0 })
      continue
    }
    if (file.verb === 'add') {
      const added = file.hunks.reduce((sum, lines) => sum + lines.filter((line) => line.startsWith('+')).length, 0)
      // git spells a whole-file creation `@@ -0,0 +1,N @@`.
      changes.push({
        path,
        additions: added,
        deletions: 0,
        ...(added > 0 ? { edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: added }] } : {}),
      })
      continue
    }
    const fileAfter = normalizeNewlines(readFileForLocate(path) ?? '')
    const edits = []
    let additions = 0
    let deletions = 0
    let located = fileAfter.length > 0
    let delta = 0
    for (const lines of file.hunks) {
      const post = hunkPostImage(lines).join('\n')
      // Locate the hunk's post-image, then walk the hunk from there: the block
      // itself includes context, and context lines are lines the agent did not
      // write and must not claim.
      const found = located ? locateBlock(fileAfter, normalizeNewlines(post)) : { kind: 'absent' }
      if (found.kind !== 'found') located = false
      const walked = walkHunkLines(lines, Math.max(1, (found.start ?? 1) - delta), found.start ?? 1, located ? edits : [])
      if (!walked) {
        located = false
        continue
      }
      additions += walked.additions
      deletions += walked.deletions
      delta += walked.additions - walked.deletions
    }
    changes.push({
      path,
      additions,
      deletions,
      ...(located && edits.length > 0 ? { edits: edits.slice(0, MAX_EDITS_PER_FRAME) } : {}),
    })
  }
  return changes
}

// A failed `apply_patch` reports nothing: Codex's response is the exec result
// text, so a non-zero exit is the tool saying it changed nothing — and a file
// the agent FAILED to edit in the ledger is exactly the wrong lie.
function codexPatchFailed(toolResponse) {
  if (typeof toolResponse !== 'string') return false
  const match = /^Exit code:\s*(-?\d+)/m.exec(toolResponse)
  return match ? match[1] !== '0' : false
}

// ---------------------------------------------------------------------------
// Cursor / Kimi / Grok: old-string/new-string edits
//
// UNVERIFIED shapes — none of the three could be run on this machine (each
// refused headless without an account: cursor-agent 2026.07.17 "Not logged in",
// kimi 0.28.1 "No model configured", grok 1.0.13 "Not signed in"). Built from
// vendor docs and, for Grok, the hook documentation embedded in its own binary.
// Every field is therefore read under every spelling the docs use, and a
// payload that matches none simply produces nothing.
//
//   Cursor  `afterFileEdit` — file_path + edits: [{ old_string, new_string }],
//           applied in order. (Its postToolUse carries no edit at all, which is
//           why the manifest registers this event too.) cursor-agent
//           2026.09.08.
//   Kimi    PostToolUse with Claude's tool NAMES and its own input: `Edit`
//           { path, old_string, new_string, replace_all } and `Write`
//           { path, content }, a plain-text result, no structuredPatch, and
//           `{ isError: true }` on failure. kimi-code 0.42.0, read off the
//           shipped binary's tool schemas.
//   Grok    PostToolUse (the payload spells it `post_tool_use`), tool_name
//           `search_replace` — Grok Build's own name for Edit/Write/MultiEdit —
//           and `write`, with camelCase envelope fields (toolName/toolInput).
//           grok 1.0.24, read off the binary's tool table and embedded hook
//           docs.
// ---------------------------------------------------------------------------

// Every (old, new) pair in one tool input: the pair inline (Kimi's Edit, Grok's
// search_replace) and every entry of an `edits` list (Cursor's afterFileEdit).
// All three spell them old_string / new_string. Order is preserved, though
// `sequenceEdits` no longer depends on it.
function collectOldNewPairs(input) {
  const pairs = []
  const push = (entry) => {
    if (!entry || typeof entry !== 'object') return
    const newText = entry.new_string
    if (typeof newText !== 'string') return
    pairs.push({ old: typeof entry.old_string === 'string' ? entry.old_string : '', new: newText })
  }
  push(input)
  const list = Array.isArray(input?.edits) ? input.edits : null
  if (list) for (const entry of list) push(entry)
  return pairs
}

// `file_path` (Cursor, and Grok's search_replace) or `path` (Kimi). Claude's
// own payloads never reach here — hasClaudePathField sends them to the
// structuredPatch reader instead.
function readInputPath(input, baseDir) {
  for (const candidate of [input?.file_path, input?.path]) {
    const path = absolutePath(candidate, baseDir)
    if (path) return path
  }
  return null
}

// One file, one call: the located regions of every (old, new) pair. If ANY pair
// cannot be placed the whole call falls back to a file-level claim — a partial
// set of regions would leave the rest of the call's lines credited to whoever
// held them before, which is a wrong answer rather than a missing one.
function deriveOldNewFileChange(path, pairs) {
  let additions = 0
  let deletions = 0
  for (const pair of pairs) {
    additions += countTextLines(normalizeNewlines(pair.new))
    deletions += countTextLines(normalizeNewlines(pair.old))
  }
  const fileAfter = readFileForLocate(path)
  const located = []
  for (const pair of pairs) {
    const edit = locateEdit(fileAfter, pair.old, pair.new)
    if (!edit) return { path, additions, deletions }
    located.push(edit)
  }
  const edits = sequenceEdits(located)
  return { path, additions, deletions, ...(edits.length > 0 ? { edits } : {}) }
}

// A whole-file write (Kimi's WriteFile, Grok's write). No `edits`: the call
// replaced the file, so the honest claim is the FILE — and without the previous
// content there is no old-side range to give, only a guess that would move
// every other agent's spans by the wrong amount. `deletions` stays 0 for the
// same reason.
function deriveWriteFileChange(path, input) {
  const content = [input?.content, input?.contents].find((value) => typeof value === 'string')
  return { path, additions: typeof content === 'string' ? countTextLines(normalizeNewlines(content)) : 0, deletions: 0 }
}

// Claude Code's file-editing tools (2.1.266 — its own set, verified: MultiEdit
// is still one of them). Kimi Code 0.42 reuses two of these NAMES for tools of
// its own, which is what hasClaudePathField below is for; a tool named nothing
// on this list, or on the three below, simply never matches — the safe
// direction, since no ledger beats a wrong one.
const FILE_EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Codex's only editing tool (codex-cli 0.153.4, verified).
const PATCH_TOOL_NAMES = new Set(['apply_patch'])

// Grok Build's editing tool: `search_replace` is its own name for what Claude
// calls Edit/Write/MultiEdit (grok 1.0.24, read off the binary's tool table).
const STR_REPLACE_TOOL_NAMES = new Set(['search_replace'])

// Grok Build's whole-file write. Kimi's `Write` reaches the same reader through
// the Claude-named set below, since it shares the NAME and not the input.
const WRITE_TOOL_NAMES = new Set(['write'])

// The PostToolUse spellings that carry a tool NAME, INPUT and RESULT — which is
// what both reads below need (the file edit, and the pull request capture).
// Claude/Codex/Kimi send `PostToolUse`; Grok's payload spells the same event
// `post_tool_use`. Cursor's `postToolUse` is deliberately NOT here — its payload
// carries no tool detail at all, so its edits arrive on the dedicated
// `afterFileEdit` event instead and its pull requests stay on the app's branch
// lookup (epic `pull-request-marks`, decision 8b).
const FILE_EDIT_EVENT_NAMES = new Set(['PostToolUse', 'post_tool_use'])
const CURSOR_FILE_EDIT_EVENT = 'afterFileEdit'

// Claude Code's file-watcher event (2.1.266). It fires for a path a hook has
// armed with hookSpecificOutput.watchPaths, and carries `file_path` + `event`
// (change | add | unlink) — a touch, never a diff.
const WATCHED_FILE_EVENT = 'FileChanged'

// True when the payload names its file the way Claude Code does. Claude's tool
// RESULT is the object the diff lives on; Kimi Code 0.42 reuses the tool NAMES
// (Edit / Write) with `path` and a plain-text result, so this — not the tool
// name — is what picks the reader.
function hasClaudePathField(input, payload) {
  const response = payload?.tool_response ?? payload?.toolResponse
  const named = (value) => typeof value === 'string' && value.trim().length > 0
  return (
    named(input?.file_path) ||
    named(input?.filePath) ||
    named(input?.notebook_path) ||
    named(input?.notebookPath) ||
    (!!response && typeof response === 'object' && (named(response.filePath) || named(response.file_path)))
  )
}

// A call that failed changed nothing, and a file the agent FAILED to edit is
// the one entry worse than a missing one. Kimi returns `{ isError: true }`;
// Claude's failures come back as a string or an object carrying `error`. (Each
// of these CLIs also has a separate PostToolUseFailure event, which this
// reporter never reads an edit out of — this is the belt to that event's braces.)
function toolCallFailed(response) {
  if (typeof response === 'string') return /^\s*error\b/i.test(response)
  if (!response || typeof response !== 'object') return false
  return Boolean(response.error || response.is_error || response.isError)
}

/**
 * Every file one tool call changed, as frames' worth of fileChange — the table
 * that keys (event spelling, tool name) onto the CLI's own edit vocabulary.
 * Returns a LIST because one Codex patch can rewrite several files, and the
 * frame format carries one file each.
 */
function deriveFileChanges(event, toolName, payload) {
  const input = payload?.tool_input ?? payload?.toolInput
  const baseDir = payloadBaseDir(payload)

  if (event === CURSOR_FILE_EDIT_EVENT) {
    // Cursor's own edit event: the payload IS the edit, with no tool wrapper.
    const path = readInputPath(payload, baseDir)
    if (!path) return []
    const pairs = collectOldNewPairs(payload)
    return pairs.length > 0 ? [deriveOldNewFileChange(path, pairs)] : [{ path, additions: 0, deletions: 0 }]
  }

  if (event === WATCHED_FILE_EVENT) {
    // Claude Code's file WATCHER (2.1.266): `file_path` plus `event`
    // (change | add | unlink), and no diff of any kind. It is the only signal
    // for an edit the agent made through Bash, a formatter or a codegen step,
    // so it is recorded as a TOUCH — path only, no counts, no ranges — which
    // claims the file at file level and cannot double-count a tool call's own
    // frame (both name the same path, and 0 + 0 changes no count).
    const path = absolutePath(payload?.file_path ?? payload?.filePath, baseDir)
    return path ? [{ path, additions: 0, deletions: 0 }] : []
  }

  if (!FILE_EDIT_EVENT_NAMES.has(event) || !toolName) return []

  if (PATCH_TOOL_NAMES.has(toolName)) {
    if (codexPatchFailed(payload?.tool_response ?? payload?.toolResponse)) return []
    const patch = [input?.command, input?.patch, input?.input].find((value) => typeof value === 'string')
    return typeof patch === 'string' ? deriveCodexFileChanges(patch, baseDir) : []
  }

  // Claude Code's own vocabulary: the tool RESULT object carries a ready-made
  // diff, and `file_path` is what names the file. Kimi Code 0.42 spells its
  // editing tools with the same NAMES (Edit / Write) but a different input
  // (`path`, and a text result with no patch), so the two are told apart by
  // the field that names the file rather than by the tool name.
  if (FILE_EDIT_TOOL_NAMES.has(toolName) && hasClaudePathField(input, payload)) {
    const change = deriveFileChange(payload?.tool_response ?? payload?.toolResponse, input)
    if (!change) return []
    const path = absolutePath(change.path, baseDir)
    return path ? [{ ...change, path }] : []
  }

  if (FILE_EDIT_TOOL_NAMES.has(toolName) || STR_REPLACE_TOOL_NAMES.has(toolName) || WRITE_TOOL_NAMES.has(toolName)) {
    if (toolCallFailed(payload?.tool_response ?? payload?.toolResponse ?? payload?.tool_output ?? payload?.toolOutput)) {
      return []
    }
    const path = readInputPath(input, baseDir)
    if (!path) return []
    const pairs = WRITE_TOOL_NAMES.has(toolName) ? [] : collectOldNewPairs(input)
    if (pairs.length > 0) return [deriveOldNewFileChange(path, pairs)]
    return [deriveWriteFileChange(path, input)]
  }

  return []
}

// ---------------------------------------------------------------------------
// Pull request capture (epic `pull-request-marks`, decision 8b)
//
// The reporter already sees every tool call's input and result, so the moment
// an agent opens a pull request is a moment it is TOLD about — no polling, no
// `gh` of its own. One more read on the same PostToolUse the file ledger uses.
//
// Two gates, and nothing else counts:
//   * a shell command containing `gh pr create` — Claude's `Bash`, Kimi's
//     `Bash`, Grok's `bash`, Codex's `shell` (whose `command` is an argv ARRAY,
//     not a string). `gh pr view` / `gh pr list` do not match the literal, and a
//     plain shell that never runs the creation never produces one.
//   * a tool NAME ending in `vcs_pr` — the sprint MCP tool
//     (`mcp__sprintengine-studio__sprintengine_vcs_pr` through Claude's hook),
//     whose result is an MCP content array rather than a command's stdout.
//
// The URL is read from the tool RESULT only, never from `tool_input`: the input
// is the agent's own text, and an agent that merely TYPED a pull request URL has
// not opened one. What is forwarded is the URL and nothing else — never the raw
// output.
// ---------------------------------------------------------------------------

// The wire-side twin of `parsePullRequestUrl` (src/shared/git/pr-url.ts).
// This file is copied into a workspace and run by the CLI, so it can import
// nothing from src/ — this ONE regex is the documented duplicate, and main
// re-validates every URL through the real parser before believing it.
//
// `<host>/<owner>/<repo>/pull/<n>`, any host (GitHub Enterprise lives on the
// company's own domain, optionally with a port). The `/pull/` segment and the
// digits are what make it a pull request: an issue (`/issues/7`), a commit
// (`/commit/<sha>`) and the "create one by visiting" link `gh` prints on a push
// (`/pull/new/<branch>`) all fail to match. The trailing lookahead refuses
// `/pull/12ab`, so a number that is not a number captures nothing rather than
// its own prefix.
const PULL_REQUEST_URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+(?![\w])/

// `gh pr create`, however the shell spaced it. Anchored on word boundaries so
// `/usr/local/bin/gh pr create` matches and `gh pr list` never does.
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/

// The shell command a tool call ran, under every spelling the hooked CLIs use.
// Claude / Kimi / Grok's Bash-style tools put a STRING on `command`; Codex's
// shell tool puts the argv ARRAY there (`['bash', '-lc', 'gh pr create …']`).
// Anything else reads as no command at all.
function readToolCommand(input) {
  if (!input || typeof input !== 'object') return null
  for (const candidate of [input.command, input.cmd, input.script]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (Array.isArray(candidate)) {
      const parts = candidate.filter((part) => typeof part === 'string')
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return null
}

// Whether this tool call is one that can have opened a pull request. Cheap, and
// checked BEFORE the result is scanned so an ordinary `cat` of a file that
// happens to hold a pull request URL captures nothing.
function isPullRequestCreation(toolName, input) {
  if (typeof toolName === 'string' && toolName.trim().toLowerCase().endsWith('vcs_pr')) return true
  const command = readToolCommand(input)
  return typeof command === 'string' && GH_PR_CREATE_RE.test(command)
}

// One string's first pull request URL. `gh pr create` prints exactly one (the
// last line of its output); the sprint MCP tool answers with the primary's URL
// first. FIRST match, so the answer is deterministic when a run spans repos.
//
// Past the scan cap the string is read at BOTH ends, because `gh` prints the URL
// last and a noisy push can put a megabyte in front of it. The two ends are
// searched SEPARATELY: the head is a cut string, so a match that runs to its
// very end may be half a URL whose number continues past the cut (`/pull/1` of
// `/pull/1234` — a real pull request, and the wrong one), and only a match that
// ends inside the slice is believed. A cut at the START of the tail can produce
// no false match at all: what is left of a URL there no longer begins `https://`.
function matchPullRequestUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  if (text.length <= MAX_PULL_REQUEST_SCAN_LENGTH) return firstPullRequestUrl(text, false)
  const half = MAX_PULL_REQUEST_SCAN_LENGTH / 2
  return firstPullRequestUrl(text.slice(0, half), true) ?? firstPullRequestUrl(text.slice(-half), false)
}

function firstPullRequestUrl(text, mustEndInside) {
  const match = PULL_REQUEST_URL_RE.exec(text)
  if (!match) return null
  if (mustEndInside && match.index + match[0].length >= text.length) return null
  const url = match[0]
  return url.length <= MAX_PULL_REQUEST_URL_LENGTH ? url : null
}

// The fields a tool result hides its text in. Claude's Bash and Grok hand back a
// plain STRING; Codex's shell tool hands back its `Exit code: N / Wall time: … /
// Output: …` string; an MCP tool hands back an object whose `content` is an
// ARRAY of `{ type: 'text', text }` parts (and, on newer servers, the same
// answer again under `structuredContent`). `stdout` / `stderr` / `output` /
// `result` cover the CLIs that wrap a command result in an object of their own —
// `stderr` included because `gh` prints the "a pull request already exists"
// line, URL and all, on the error stream. `pullRequestUrl` is the sprint tool's
// own field name, for a server that answers with a value rather than text.
const TOOL_RESPONSE_TEXT_FIELDS = [
  'stdout',
  'stderr',
  'output',
  'content',
  'text',
  'result',
  'structuredContent',
  'pullRequestUrl',
]

// The pull request URL a tool result carries, wherever in it the CLI put it.
// Bounded in depth and in breadth: an untrusted payload must cost a fixed amount
// of work, and a URL nested five objects deep is not a shape any of these CLIs
// produce.
//
// A FAILED call is not excluded, deliberately: `gh pr create` exits non-zero
// when the branch already has a pull request, and prints that pull request's
// URL — which is a pull request this conversation's branch really has. The URL
// only ever appears when one EXISTS.
function extractPullRequestUrl(response, depth = 0) {
  if (depth > 4) return null
  if (typeof response === 'string') return matchPullRequestUrl(response)
  if (Array.isArray(response)) {
    for (const entry of response.slice(0, 50)) {
      const url = extractPullRequestUrl(entry, depth + 1)
      if (url) return url
    }
    return null
  }
  if (!response || typeof response !== 'object') return null
  for (const field of TOOL_RESPONSE_TEXT_FIELDS) {
    const url = extractPullRequestUrl(response[field], depth + 1)
    if (url) return url
  }
  return null
}

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
    socket.on('error', () => {
      done(false)
    })
    socket.on('connect', () => {
      // Newline-delimited: the reader splits on '\n', so several frames ride
      // one connection rather than one connect (and one retry budget) each.
      socket.write(frames.map((frame) => JSON.stringify(frame) + '\n').join(''), () => {
        socket.end()
      })
    })
    socket.on('close', () => done(true))
  })
}

// A duplicate delivery (write landed but the ack path errored, then a retry
// re-sent) is harmless: the runtime re-ingests the identical phase/ts, a no-op
// — so no send-side idempotency is needed. Total failure stays silent (exit 0).
async function writeFrame(socketPath, frames) {
  const startedAt = Date.now()
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (await writeFrameOnce(socketPath, frames)) return
    if (Date.now() - startedAt + RETRY_BACKOFF_MS >= TOTAL_DEADLINE_MS) return
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const socketPath = studioEnv('SPRINTENGINE_AGENT_STATE_SOCKET') || args.socket
  if (!socketPath) return

  const agentId = studioEnv('SPRINTENGINE_AGENT_ID')
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
    workspaceId: studioEnv('SPRINTENGINE_WORKSPACE_ID') ?? null,
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
  // `PostToolUse` is Claude/Codex/Kimi vocabulary; Grok's payload spells the
  // same event `post_tool_use`; Cursor's edits arrive on its own
  // `afterFileEdit` event (its `postToolUse` payload carries no edit at all).
  // See deriveFileChanges for the per-CLI vocabulary table.
  const fileChanges = deriveFileChanges(event, toolName, payload)

  // The CLI's OWN id for this tool call, forwarded on the PostToolUse-shaped
  // events so the app can tell a second REGISTRATION of this reporter apart
  // from a second edit. The app installs the reporter twice — merged by hand
  // into `.claude/settings.local.json`, and declared again by the studio
  // plugin's `hooks/hooks.json` — and once Claude Code loads the plugin
  // natively both fire on the same tool call. The two frames are then identical
  // in every field including this one, because the id belongs to the CLI, not
  // to the hook process; a genuinely second edit is a second tool call with a
  // different id. Main keys a small per-session ring on `(toolUseId, path)`
  // (see ingestAgentStateFrame) and folds each pair exactly once.
  //
  // Claude/Codex/Kimi spell it `tool_use_id`, Grok `toolUseId`. The payload is
  // the gate: only the PostToolUse-shaped events carry one at all. Cursor's
  // `afterFileEdit` has no tool wrapper and so no id — those frames fall back
  // to main's timestamp-windowed key.
  const toolUseId = str(payload?.tool_use_id) ?? str(payload?.toolUseId)
  if (toolUseId) {
    const trimmed = toolUseId.trim()
    if (trimmed && trimmed.length <= MAX_TOOL_USE_ID_LENGTH) frame.toolUseId = trimmed
  }

  // The pull request the agent just opened, forwarded on the same PostToolUse
  // (epic `pull-request-marks`, decision 8b): the app files it against this
  // conversation the moment it exists, instead of waiting for the branch lookup
  // to notice. See the capture section above for the two gates and the one
  // regex. Only the URL rides the frame — never the command, never the output.
  // A capture is filed by the URL's OWN repository in main, so
  // `cd ../website && gh pr create` is captured correctly even though this
  // session never left its checkout.
  if (FILE_EDIT_EVENT_NAMES.has(event)) {
    const toolInput = payload?.tool_input ?? payload?.toolInput
    if (isPullRequestCreation(toolName, toolInput)) {
      const url = extractPullRequestUrl(
        payload?.tool_response ?? payload?.toolResponse ?? payload?.tool_output ?? payload?.toolOutput
      )
      if (url) frame.pullRequest = { url }
    }
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

  // One frame per changed FILE (a Codex patch can rewrite several in one call),
  // all carrying the identical event and ts so the phase fold stays idempotent
  // — the runtime re-ingesting the same phase/ts is a no-op, and the ledger
  // reads each file change once. No file change: the phase frame still goes,
  // exactly as before.
  const frames =
    fileChanges.length > 0 ? fileChanges.map((fileChange) => ({ ...frame, fileChange })) : [frame]
  await writeFrame(socketPath, frames)
}

main()
  .catch(() => {
    // Never let a reporter error break Claude.
  })
  .finally(() => {
    process.exit(0)
  })
