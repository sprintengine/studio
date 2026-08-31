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
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      socket.write(JSON.stringify(frame) + '\n', () => socket.end())
    })
    socket.on('close', () => done(true))
  })
}

async function writeFrame(socketPath, frame) {
  const startedAt = Date.now()
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (await writeFrameOnce(socketPath, frame)) return
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
// Dedup consecutive identical phases — OpenCode emits `message.updated` on every
// streamed delta (dozens/sec), all mapping to `thinking`, so without this a turn
// would open one socket per delta. The session is fixed for the process, so the
// phase alone is the key; a real transition (thinking→tool_use, →awaiting_input
// after a permission, →idle) always differs and is sent. The runtime's stall
// watch reads live output, not this cadence, so a quiet `thinking` is still caught.
let lastPhase = null

async function report(phase, event, sessionId) {
  if (!phase) return
  // Seed the lock before the dedup early-return, so the root id is captured even
  // from a frame we suppress (the first frame, `starting`, is never a dup).
  if (sessionId && !lockedSessionId) lockedSessionId = sessionId
  if (phase === lastPhase) return
  lastPhase = phase
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
  await writeFrame(socketPath, frame)
}

// OpenCode plugin entrypoint: an exported async function returning a hooks
// object. The generic `event` hook receives the typed lifecycle event stream;
// `tool.execute.before/after` are separate named hooks (not part of that stream)
// and give the tool_use phase, mirroring Claude's PreToolUse/PostToolUse split.
export const MulticodeAgentState = async () => {
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
    'tool.execute.after': async (input) => {
      try {
        const sessionId = input && typeof input.sessionID === 'string' ? input.sessionID : null
        await report('thinking', 'tool.execute.after', sessionId)
      } catch {
        // Never let a reporter error break OpenCode.
      }
    },
  }
}
