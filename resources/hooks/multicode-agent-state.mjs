#!/usr/bin/env node
// Multicode authoritative-agent-state reporter for Claude Code.
//
// Registered for the agent lifecycle events (SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionEnd). Reads
// Claude's hook JSON from stdin, maps `hook_event_name` to an agent phase, and
// writes a single newline-delimited JSON frame to the Multicode agent-state
// socket so the app learns the agent's true phase instead of guessing from
// output timing. The agent's identity comes from the MULTICODE_* env the app
// injects at launch.
//
// Args:
//   --socket <path>   Agent-state socket (unix domain socket / named pipe).
//                     Falls back to MULTICODE_AGENT_STATE_SOCKET.
//
// The script ALWAYS exits 0 and never blocks meaningfully: a reporter failure
// must never break or stall the agent.

import { connect } from 'node:net'

const CONNECT_TIMEOUT_MS = 1000

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

// Must mirror mapHookEventToPhase in src/main/agent-state.ts.
function mapEventToPhase(event) {
  switch (event) {
    case 'SessionStart':
      return 'starting'
    case 'UserPromptSubmit':
      return 'thinking'
    case 'PreToolUse':
      return 'tool_use'
    case 'PostToolUse':
      return 'thinking'
    case 'Notification':
    case 'PermissionRequest':
      return 'awaiting_input'
    case 'Stop':
    case 'SubagentStop':
      return 'idle'
    case 'SessionEnd':
      return 'exited'
    default:
      return null
  }
}

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
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.on('timeout', () => {
      socket.destroy()
      done()
    })
    socket.on('error', () => {
      done()
    })
    socket.on('connect', () => {
      socket.write(JSON.stringify(frame) + '\n', () => {
        socket.end()
      })
    })
    socket.on('close', () => done())
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const socketPath = args.socket || process.env.MULTICODE_AGENT_STATE_SOCKET
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

  const event = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : null
  const phase = event ? mapEventToPhase(event) : null
  if (!phase) return

  const frame = {
    type: 'agent_state',
    agentId,
    workspaceId: process.env.MULTICODE_WORKSPACE_ID ?? null,
    sessionId: typeof payload?.session_id === 'string' ? payload.session_id : null,
    phase,
    event,
    ts: Date.now(),
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
