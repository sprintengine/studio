#!/usr/bin/env node
// Multicode status-line forwarder — the stdin filter Claude Code's `statusLine`
// setting runs, and the only way the app learns how much of a session's context
// window is gone.
//
// Claude Code refreshes the status line after each assistant message, after a
// /compact, on a permission-mode change and on a rate-limit reset, piping a JSON
// document to the configured command's stdin and painting whatever the command
// prints. The app installs ITSELF as that command (see installAgentStateReporter
// in src/main/agent-state.ts) so those refreshes become agent-state frames — and,
// because a person may already have a status line of their own, the install
// hands us theirs in `--wrap` and this script runs it with the same stdin bytes
// and passes its stdout and exit code straight through. From the person's side
// nothing changed; from the app's side every refresh is a reading.
//
//   --socket <path>   Agent-state socket, baked in at install time. The env
//                     `MULTICODE_AGENT_STATE_SOCKET` WINS over it, for the same
//                     reason it does in the agent-state reporter: the arg lives
//                     in the repo's shared settings.local.json, which is
//                     last-writer-wins across app instances, while the env is
//                     per-process and always names the instance that launched
//                     this session.
//   --wrap <base64>   base64 of {"command": "<their status line>", "cwd"?: "…"}.
//                     Absent ⇒ this script prints NOTHING and exits 0, which is
//                     a blank status line: the app installs itself only where
//                     the person had none, so there is nothing to print.
//
// Rules this script never breaks:
//   * A session launched outside the app (no MULTICODE_AGENT_ID, no socket) is
//     none of our business: report nothing, but STILL run the wrapped command,
//     so a person whose status line we wrapped keeps their status line whether
//     or not the app started the session.
//   * A socket failure never reaches the status line. The frame write is a
//     single short-timeout attempt (no retry — a status line refreshes far too
//     often to be worth retrying, and the next refresh carries a fresher
//     reading anyway) that runs CONCURRENTLY with the wrapped command, so a
//     dead socket costs the person nothing but the timeout, in parallel.
//   * Only the seven numbers and names below ever ride the socket. The payload
//     also carries the transcript path, the repo identity, the prompt cache and
//     the person's cwd; none of it is ours to forward from here.
//
// The frame's `event` is `StatusLine`, which is deliberately in NO manifest's
// agentStateSpec: a status-line refresh is not a lifecycle event and must move
// no phase. The main process folds `statusLine` in before the phase resolution
// drops the frame, exactly as it folds a file change.

import { spawn } from 'node:child_process'
import { connect } from 'node:net'

// One attempt, short. The reporter retries because a lost `Stop` strands a
// session; a lost status-line reading is replaced by the next refresh.
const SOCKET_TIMEOUT_MS = 500
// Claude's status-line payload is a couple of kilobytes. A megabyte is already
// far past anything real, so past it we report nothing: a document that large
// is not one we are going to believe, and a truncated one would not parse.
const MAX_STDIN_BYTES = 1024 * 1024
// But the WRAPPED command still gets everything, up to a far higher ceiling.
// Handing the person's own script half a JSON document is strictly worse than
// handing it the whole thing — it is their script's input, not ours, and the
// writer on the other end is Claude Code itself. The ceiling exists only so a
// runaway writer cannot grow this process without bound.
const MAX_FORWARDED_STDIN_BYTES = 16 * 1024 * 1024
// Send-side cap on the two free-text fields. Mirrors MAX_STATUS_LINE_NAME_LENGTH
// in src/main/agent-state.ts, which caps again on receipt — this script is
// untrusted input, so the cap here is a courtesy, not the enforcement.
const MAX_NAME_LENGTH = 256

// --- socket write ----------------------------------------------------------
// Deliberately a MINIMAL DUPLICATE of writeFrameOnce in
// multicode-agent-state.mjs rather than an import: these are bundled scripts
// COPIED one-by-one into a workspace's .multicode/hooks/ (see
// AGENT_STATE_HOOK_SCRIPT_REL / STATUS_LINE_HOOK_SCRIPT_REL), so an import
// between them would resolve only when both copies happen to be present and
// current — a coupling neither the installer nor the packaging filter
// guarantees. The retry/backoff half of the reporter's logic is deliberately
// NOT duplicated (see SOCKET_TIMEOUT_MS above).
function writeFrame(socketPath, frame) {
  return new Promise((res) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      res()
    }
    let socket
    try {
      socket = connect(socketPath)
    } catch {
      done()
      return
    }
    socket.setTimeout(SOCKET_TIMEOUT_MS)
    socket.on('timeout', () => {
      socket.destroy()
      done()
    })
    socket.on('error', done)
    socket.on('connect', () => {
      socket.write(JSON.stringify(frame) + '\n', () => {
        socket.end()
      })
    })
    socket.on('close', done)
  })
}

// --- stdin -----------------------------------------------------------------
// Read as BYTES, not text: the same buffer is handed to the wrapped command,
// and a decode/re-encode round trip through a lone surrogate would change what
// the person's own script sees.
function readStdin() {
  return new Promise((res) => {
    const chunks = []
    let size = 0
    let overParseCap = false
    const finish = () => res({ data: Buffer.concat(chunks), overParseCap })
    process.stdin.on('data', (chunk) => {
      if (size >= MAX_FORWARDED_STDIN_BYTES) return
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_STDIN_BYTES) overParseCap = true
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    if (process.stdin.isTTY) finish()
  })
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--socket') {
      args.socket = argv[i + 1]
      i += 1
    } else if (argv[i] === '--wrap') {
      args.wrap = argv[i + 1]
      i += 1
    }
  }
  return args
}

// The wrapped command, as the installer base64-encoded it. Anything malformed
// means no wrapped command at all — never a half-decoded string handed to a
// shell.
function decodeWrap(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const command = typeof parsed.command === 'string' ? parsed.command : null
  if (!command || !command.trim()) return null
  // `cwd` is accepted because the wrap envelope declares it, but the installer
  // never writes one: Claude runs the status line from the session's own cwd,
  // and pinning it elsewhere would change what the person's script reports.
  const cwd = typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : null
  return { command, cwd }
}

// Run the person's own status line with the same stdin bytes, its stdout and
// stderr wired straight to ours (so colours, OSC 8 links and multi-line output
// arrive at Claude exactly as they would have without us), and resolve to its
// exit code. A spawn failure resolves 0: a status line that cannot start is a
// blank status line, not a broken session.
function runWrapped(wrapped, stdinData) {
  return new Promise((res) => {
    const isWindows = process.platform === 'win32'
    // Through the person's own shell, so a command that leans on their shell's
    // syntax or startup files behaves as it does when they run it. The known
    // risk is the other direction: Claude Code does not document which shell it
    // spawns for a status line, so a POSIX one-liner written against /bin/sh
    // could now run under a `$SHELL` of fish or csh. `/bin/sh` is the fallback,
    // never the override — a person who set `$SHELL` set it deliberately.
    // The Windows form mirrors Node's own child_process.exec: cmd.exe with the
    // command as ONE verbatim argument, so its quoting survives.
    const shell = isWindows
      ? process.env.ComSpec || 'cmd.exe'
      : process.env.SHELL || '/bin/sh'
    const args = isWindows ? ['/d', '/s', '/c', `"${wrapped.command}"`] : ['-c', wrapped.command]
    let child
    try {
      child = spawn(shell, args, {
        ...(wrapped.cwd ? { cwd: wrapped.cwd } : {}),
        stdio: ['pipe', 'inherit', 'inherit'],
        ...(isWindows ? { windowsVerbatimArguments: true } : {}),
      })
    } catch {
      res(0)
      return
    }
    // Claude Code kills a status-line command that runs too long. Before this
    // script existed that killed the person's command; now it kills us, and
    // without this the command would be orphaned — still holding the inherited
    // stdout of a status line nobody is reading any more, one leaked process per
    // slow refresh. So a signal aimed at us is passed straight down.
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
    // Passing the signal down is not enough on its own: trapping TERM to clean
    // up is an ordinary thing for a status-line script to do, and exiting the
    // same tick would leave exactly the orphan this relay exists to prevent —
    // still holding the inherited stdout of a pipe nobody will read to EOF. So
    // we wait for the child to actually go, and insist shortly after.
    const relay = (signal) => {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
      child.once('close', () => process.exit(0))
      const deadline = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        process.exit(0)
      }, 200)
      deadline.unref?.()
    }
    const handlers = signals.map((signal) => {
      const handler = () => relay(signal)
      process.on(signal, handler)
      return [signal, handler]
    })
    const release = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    }
    child.on('error', () => {
      release()
      res(0)
    })
    child.on('close', (code, signal) => {
      release()
      res(signal ? 1 : code ?? 0)
    })
    // A command that ignores its stdin (most do) closes the pipe early; writing
    // into it then EPIPEs, which is not an error worth reporting.
    child.stdin.on('error', () => {})
    child.stdin.end(stdinData)
  })
}

// --- frame -----------------------------------------------------------------
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null
const name = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null
}

/**
 * The status-line payload reduced to the fields the app keeps. Every one is
 * OMITTED when absent or null — `context_window.used_percentage` is null before
 * the first API call and again right after a /compact, and a null there means
 * "not known yet", never "zero" (the main process keeps the last known reading
 * rather than clearing it; see ingestAgentStateFrame).
 *
 * Returns null when the payload yields nothing at all, so a refresh with no
 * numbers costs no socket connection.
 */
function buildStatusLine(payload) {
  const statusLine = {}
  const contextWindow = record(payload.context_window)
  if (contextWindow) {
    const usedPercentage = number(contextWindow.used_percentage)
    if (usedPercentage !== null) statusLine.usedPercentage = usedPercentage
    const contextWindowSize = number(contextWindow.context_window_size)
    if (contextWindowSize !== null) statusLine.contextWindowSize = contextWindowSize
  }
  const cost = record(payload.cost)
  if (cost) {
    const totalCostUsd = number(cost.total_cost_usd)
    if (totalCostUsd !== null) statusLine.totalCostUsd = totalCostUsd
    const linesAdded = number(cost.total_lines_added)
    if (linesAdded !== null) statusLine.linesAdded = linesAdded
    const linesRemoved = number(cost.total_lines_removed)
    if (linesRemoved !== null) statusLine.linesRemoved = linesRemoved
  }
  // The name a person recognizes ("Opus") before the id ("claude-opus-5").
  const model = name(record(payload.model)?.display_name) ?? name(record(payload.model)?.id)
  if (model) statusLine.model = model
  // Absent until the session is named by --name, /rename or an AI title.
  const sessionName = name(payload.session_name)
  if (sessionName) statusLine.sessionName = sessionName
  return Object.keys(statusLine).length > 0 ? statusLine : null
}

function buildFrame(data, agentId) {
  // Strip a leading UTF-8 BOM, as the agent-state reporter does.
  const text = data.toString('utf8').replace(/^﻿/, '')
  if (!text.trim()) return null
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!record(payload)) return null
  const statusLine = buildStatusLine(payload)
  if (!statusLine) return null
  return {
    type: 'agent_state',
    agentId,
    workspaceId: process.env.MULTICODE_WORKSPACE_ID ?? null,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    event: 'StatusLine',
    ts: Date.now(),
    statusLine,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const wrapped = decodeWrap(args.wrap)
  const { data, overParseCap } = await readStdin()

  // Started before the socket write and awaited alongside it, so the person's
  // status line never waits on ours. (It cannot start before stdin is read —
  // the same bytes are its input.)
  const wrappedRun = wrapped ? runWrapped(wrapped, data) : Promise.resolve(0)

  const socketPath = process.env.MULTICODE_AGENT_STATE_SOCKET || args.socket
  const agentId = process.env.MULTICODE_AGENT_ID
  let sent = Promise.resolve()
  if (socketPath && agentId && !overParseCap) {
    const frame = buildFrame(data, agentId)
    if (frame) sent = writeFrame(socketPath, frame)
  }

  const [code] = await Promise.all([wrappedRun, sent])
  return code
}

main()
  .then((code) => {
    // Exit explicitly rather than falling off the end: the stdin listeners above
    // hold the stream referenced, and a status line that never exits is one
    // Claude Code cancels on the next refresh. The wrapped command has already
    // closed by here, and its output went straight to our fds (stdio inherit),
    // so nothing is left buffered to lose.
    process.exit(typeof code === 'number' ? code : 0)
  })
  .catch(() => {
    // Never let a forwarder error break the status line.
    process.exit(0)
  })
