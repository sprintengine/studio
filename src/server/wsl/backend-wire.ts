import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { createControlRpc, type ControlRpc, type ControlRpcFrame } from '../bootstrap/control-rpc'
import type { ConversationBackend, ConversationBackendMember } from '../core/conversation-backend'

// The conversation backend across the front door: a WSL server's chats, as
// the Windows side's router drives them (phase 7 spec, 5.1).
//
// Both ends are one build (the server tree is installed per app version, its
// digest is checked before it runs, and the build its `boot` frame names is
// checked against the tree's `build.json`), so this wire is private and
// version-locked, as the helper's is: every `ConversationBackend` member the
// router forwards is one request, by name, with its arguments as they are;
// every chat event is pushed as it is published, with the summary of the
// session it belongs to, so the Windows side's synchronous `listSessions` is
// current when that event reaches its listeners. A whole snapshot follows a
// burst of events, which is how a session that left is noticed.
//
// The Studio protocol's public `conversation.*` surface is not used for this:
// it does not cover the thread index, transcripts, receipts or the handoff
// the in-process callers rely on, and widening a published protocol for one
// private caller would make every one of those a compatibility promise.
//
// One JSON frame per line, the control RPC's own frames (`req`, `res`, `event`).

/** Members answered over the wire. The synchronous ones are the router's to answer (from the mirror, or locally). */
export const REMOTE_BACKEND_MEMBERS = [
  'startSession',
  'sendTurn',
  'hasCommandReceipt',
  'respondToRequest',
  'setPermission',
  'setModel',
  'interrupt',
  'stopSession',
  'suspendSession',
  'terminalHandoffTarget',
  'stopForTerminalHandoff',
  'endTerminalHandoff',
  'noteTerminalHandoff',
  'getToolDetail',
  'findToolCall',
  'readAttachment',
  'planDocument',
  'listThreads',
  'searchThreads',
  'renameThread',
  'deleteTranscript',
  'readTranscript',
  'readPeekTranscript',
  'readConversationSync',
  'readConversationPage',
  'recoverTranscript',
  'getTurnDiff',
  'listApprovalRules',
  'revokeApprovalRule',
  'revertToTurn',
  'rewindToTurn',
  'forkAtTurn',
] as const satisfies readonly ConversationBackendMember[]

export type RemoteBackendMember = (typeof REMOTE_BACKEND_MEMBERS)[number]

const REMOTE_MEMBERS: ReadonlySet<string> = new Set(REMOTE_BACKEND_MEMBERS)

export const BACKEND_WIRE = {
  call: 'backend.call',
  snapshot: 'backend.snapshot',
  event: 'backend.event',
  sessions: 'backend.sessions',
} as const

/** A pushed chat event, with its session as the server sees it once the event is published. */
export type BackendEventFrame = { event: ConversationEvent; session: ConversationSessionSummary | null }

const SNAPSHOT_DEBOUNCE_MS = 100
// A turn is one call: `sendTurn` answers when the reply has finished. The wire
// closing is what ends a call early, not a clock.
const CALL_TIMEOUT_MS = 12 * 60 * 60 * 1000
const MAX_LINE_BYTES = 64 * 1024 * 1024

/** One JSON frame per line over a byte stream, both ways. */
export function lineFrames(stream: Duplex): {
  send(frame: unknown): void
  onFrame(listener: (frame: unknown) => void): void
  onClose(listener: (reason: string) => void): void
  close(): void
} {
  const frameListeners: Array<(frame: unknown) => void> = []
  const closeListeners: Array<(reason: string) => void> = []
  let buffer = ''
  let closed = false
  const end = (reason: string) => {
    if (closed) return
    closed = true
    for (const listener of closeListeners.splice(0)) listener(reason)
  }
  // Decoded across chunk edges: a character split between two reads stays whole.
  const decoder = new StringDecoder('utf8')
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (buffer.length > MAX_LINE_BYTES && buffer.indexOf('\n') === -1) {
      stream.destroy()
      end('A frame was larger than the wire carries.')
      return
    }
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          frame = undefined
        }
        if (frame !== undefined) for (const listener of frameListeners) listener(frame)
      }
      newline = buffer.indexOf('\n')
    }
  })
  stream.on('error', (error: Error) => end(error.message))
  stream.on('close', () => end('The connection closed.'))
  stream.on('end', () => end('The connection ended.'))
  return {
    send(frame) {
      if (closed || stream.destroyed || !stream.writable) return
      stream.write(`${JSON.stringify(frame)}\n`)
    },
    onFrame: (listener) => void frameListeners.push(listener),
    onClose(listener) {
      if (closed) listener('The connection closed.')
      else closeListeners.push(listener)
    },
    close() {
      stream.end()
      stream.destroy()
      end('Closed.')
    },
  }
}

function rpcOver(frames: ReturnType<typeof lineFrames>, log?: (message: string) => void): ControlRpc {
  const rpc = createControlRpc((frame: ControlRpcFrame) => frames.send(frame), {
    defaultTimeoutMs: CALL_TIMEOUT_MS,
    ...(log ? { log } : {}),
  })
  frames.onFrame((frame) => void rpc.receive(frame))
  frames.onClose((reason) => rpc.close(reason))
  return rpc
}

/**
 * The server's half: answer the router's calls on `backend`, and push its
 * events. Ends when the stream does.
 */
export function serveConversationBackend(
  backend: ConversationBackend,
  stream: Duplex,
  options: { log?: (message: string) => void } = {},
): { close(): void } {
  const frames = lineFrames(stream)
  const rpc = rpcOver(frames, options.log)
  rpc.handle(BACKEND_WIRE.call, async (params) => {
    const { member, args } = (params ?? {}) as { member?: unknown; args?: unknown }
    if (typeof member !== 'string' || !REMOTE_MEMBERS.has(member) || !Array.isArray(args))
      throw new Error(`The backend does not answer ${String(member)} over the wire.`)
    // Search's options carry a signal and a batch callback, neither of which
    // crosses: the hits come back whole.
    const callArgs = member === 'searchThreads' ? args.slice(0, 1) : args
    const method = (backend as unknown as Record<string, (...input: unknown[]) => unknown>)[member]
    const value = await method.apply(backend, callArgs)
    return value === undefined ? null : value
  })
  const sessions = () => {
    const listed = backend.listSessions()
    return listed.ok ? listed.sessions : []
  }
  rpc.handle(BACKEND_WIRE.snapshot, () => ({ sessions: sessions() }))
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = backend.onEvent((event) => {
    const listed = backend.listSessions({ workspaceId: event.workspaceId, agentId: event.agentId })
    const session = listed.ok ? (listed.sessions.find((entry) => entry.sessionId === event.sessionId) ?? null) : null
    rpc.emit(BACKEND_WIRE.event, { event, session } satisfies BackendEventFrame)
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      rpc.emit(BACKEND_WIRE.sessions, { sessions: sessions() })
    }, SNAPSHOT_DEBOUNCE_MS)
    snapshotTimer.unref?.()
  })
  frames.onClose(() => {
    unsubscribe()
    if (snapshotTimer) clearTimeout(snapshotTimer)
  })
  return { close: () => frames.close() }
}

/** The Windows side's view of one WSL server's chats: the backend members the wire carries, and a session mirror. */
export type RemoteConversationBackend = Pick<ConversationBackend, RemoteBackendMember | 'onEvent' | 'listSessions'> & {
  /** Read the server's sessions again (after a reconnect). */
  refresh(): Promise<void>
  /** Whether the wire is up. */
  isOpen(): boolean
  onClose(listener: (reason: string) => void): void
  close(): void
}

/**
 * The front door's half, over an admitted `backend` stream. Calls reject
 * `unavailable` once the stream is gone; the router reconnects with a new
 * stream and a new one of these.
 */
export function connectRemoteConversationBackend(
  stream: Duplex,
  options: { log?: (message: string) => void } = {},
): RemoteConversationBackend {
  const frames = lineFrames(stream)
  const rpc = rpcOver(frames, options.log)
  const mirror = new Map<string, ConversationSessionSummary>()
  const listeners = new Set<(event: ConversationEvent) => void>()
  let open = true
  frames.onClose(() => {
    open = false
  })
  const replace = (sessions: unknown) => {
    if (!Array.isArray(sessions)) return
    mirror.clear()
    for (const session of sessions as ConversationSessionSummary[]) mirror.set(session.sessionId, session)
  }
  const upsert = (session: unknown) => {
    const summary = session as ConversationSessionSummary | null | undefined
    if (summary && typeof summary.sessionId === 'string') mirror.set(summary.sessionId, summary)
  }
  rpc.on(BACKEND_WIRE.sessions, (payload) => replace((payload as { sessions?: unknown } | null)?.sessions))
  rpc.on(BACKEND_WIRE.event, (payload) => {
    const frame = payload as BackendEventFrame | null
    if (!frame?.event) return
    upsert(frame.session)
    for (const listener of [...listeners]) {
      try {
        listener(frame.event)
      } catch (error) {
        options.log?.(`A chat event listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  const call = async (member: RemoteBackendMember, args: unknown[]): Promise<unknown> => {
    const value = await rpc.call(BACKEND_WIRE.call, { member, args })
    // An action's answer carries the session as it now stands.
    upsert((value as { session?: unknown } | null)?.session)
    return value
  }
  const forward =
    (member: RemoteBackendMember) =>
    (...args: unknown[]) =>
      call(member, args)

  const remote = Object.fromEntries(REMOTE_BACKEND_MEMBERS.map((member) => [member, forward(member)])) as Record<
    RemoteBackendMember,
    (...args: unknown[]) => Promise<unknown>
  >
  return {
    ...(remote as unknown as Pick<ConversationBackend, RemoteBackendMember>),
    endTerminalHandoff: (input) => {
      void call('endTerminalHandoff', [input]).catch(() => undefined)
    },
    searchThreads: async (input, searchOptions) => {
      const result = (await call('searchThreads', [input])) as Awaited<ReturnType<ConversationBackend['searchThreads']>>
      if (result.ok && result.hits.length > 0) searchOptions?.onBatch?.(result.hits)
      return result
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listSessions(input = {}) {
      const sessions = [...mirror.values()]
        .filter((session) => !input.workspaceId || session.workspaceId === input.workspaceId)
        .filter((session) => !input.agentId || session.agentId === input.agentId)
      return { ok: true, sessions }
    },
    async refresh() {
      const snapshot = (await rpc.call(BACKEND_WIRE.snapshot, {})) as { sessions?: unknown }
      replace(snapshot?.sessions)
    },
    isOpen: () => open,
    onClose: (listener) => frames.onClose(listener),
    close: () => frames.close(),
  }
}
