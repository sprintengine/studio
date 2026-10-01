import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STUDIO_SCOPES,
  createStudioChunkAssembler,
  parseStudioServerFrame,
  type ConversationCommand,
  type ConversationCreateRequest,
  type ConversationWirePermissionPreset,
  type StudioCreatedConversation,
  type StudioGrant,
  type StudioParsedServerFrame,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationKey, ConversationSessionFrame } from '../../shared/conversation-runtime'
import { redactConversationValue } from '../../main/conversation-tool-details'
import { createStudioRpcServer, type StudioRpcServer } from './studio-rpc-server'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioCommandOutcome,
  StudioConversationBackend,
} from './studio-rpc-types'

// Test doubles for the Studio RPC: an in-memory conversation backend with the
// follow semantics of the session API (snapshot or catch-up, fence, live), an
// authenticator over a table of tokens, and a client that speaks raw lines.

type Log = { generation: string; events: ConversationEvent[]; listeners: Set<(event: ConversationEvent) => void> }

export type FakeBackend = StudioConversationBackend & {
  /** Append an event to a conversation's log and deliver it to its followers. */
  emit(agentId: string, type: ConversationEvent['type'], payload?: Record<string, unknown>): ConversationEvent
  commands: Array<{ clientId: string; commandId: string; command: ConversationCommand }>
  creates: Array<{ request: ConversationCreateRequest; launchCommandId: string }>
  presets: Map<string, ConversationWirePermissionPreset>
  followers(agentId: string): number
}

export function createFakeBackend(agentIds: string[] = ['agent-1']): FakeBackend {
  const logs = new Map<string, Log>()
  for (const agentId of agentIds) logs.set(agentId, { generation: 'log-1', events: [], listeners: new Set() })
  let seq = 0
  const receipts = new Map<string, StudioCommandOutcome>()
  const created = new Map<string, StudioCreatedConversation>()
  const backend: FakeBackend = {
    commands: [],
    creates: [],
    presets: new Map(),
    followers: (agentId) => logs.get(agentId)?.listeners.size ?? 0,
    emit(agentId, type, payload) {
      const log = logs.get(agentId)!
      const event: ConversationEvent = {
        id: `e${++seq}`,
        seq,
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        agentId,
        providerId: 'claude-agent',
        modelId: 'default',
        type,
        createdAt: 1,
        ...(payload ? { payload } : {}),
      }
      log.events.push(event)
      for (const listener of log.listeners) listener(event)
      return event
    },
    async list() {
      return [...logs.keys()].map((agentId) => ({
        workspaceId: 'ws-1',
        agentId,
        title: agentId,
        phase: 'idle' as const,
        updatedAt: 1,
        createdAt: 1,
        providerId: 'claude-agent',
        modelId: 'default',
        turnCount: 0,
        lastSeq: logs.get(agentId)!.events.at(-1)?.seq ?? 0,
      }))
    },
    resolveKey: (workspaceId, agentId) =>
      workspaceId === 'ws-1' && logs.has(agentId) ? { workspaceRoot: '/Users/dev/app', workspaceId, agentId } : null,
    follow(key: ConversationKey, cursor, listener: (frame: ConversationSessionFrame) => void) {
      const log = logs.get(key.agentId)!
      let disposed = false
      const live = (event: ConversationEvent) => {
        if (!disposed) listener({ type: 'event', event })
      }
      const ready = (async () => {
        await Promise.resolve()
        if (disposed) return
        const head = log.events.at(-1)?.seq ?? 0
        const vouched = cursor.afterSeq !== undefined && cursor.generation === log.generation && cursor.afterSeq <= head
        if (vouched) {
          for (const event of log.events) if ((event.seq ?? 0) > cursor.afterSeq!) listener({ type: 'event', event })
        } else
          listener({
            type: 'snapshot',
            page: { events: [...log.events], hasMore: false, beforeCursor: log.events[0]?.seq ?? null },
            generation: log.generation,
            ...(cursor.afterSeq !== undefined ? { reset: true as const } : {}),
          })
        listener({ type: 'synchronized', seq: head, generation: log.generation })
        log.listeners.add(live)
      })()
      return {
        ready,
        dispose: () => {
          disposed = true
          log.listeners.delete(live)
        },
      }
    },
    async loadEarlier() {
      return { ok: true, page: { events: [], hasMore: false, beforeCursor: null } }
    },
    async toolDetail(_key, toolUseId) {
      return toolUseId === 'big'
        ? {
            ok: true,
            detail: { toolUseId, output: 'é'.repeat(300_000), input: { authorization: 'Bearer abc' } } as never,
          }
        : { ok: false, code: 'not_found', message: 'No such tool call.' }
    },
    async turnDiff() {
      return { ok: false, message: 'No checkpoint.' }
    },
    async command(key, clientId, commandId, command) {
      const prior = receipts.get(commandId)
      if (prior) return prior
      backend.commands.push({ clientId, commandId, command })
      if (command.kind === 'setPermissionPreset') backend.presets.set(key.agentId, command.preset)
      const outcome: StudioCommandOutcome = { ok: true }
      receipts.set(commandId, outcome)
      return outcome
    },
    async stop() {
      return { ok: true }
    },
    permissionOf: (key) => backend.presets.get(key.agentId) ?? 'auto',
    findCreated: (launchCommandId) => created.get(launchCommandId) ?? null,
    async create(request, launchCommandId) {
      backend.creates.push({ request, launchCommandId })
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (request.workspaceId !== 'ws-1') return { ok: false, code: 'unknown_workspace', message: 'No such workspace.' }
      const agentId = `created-${backend.creates.length}`
      logs.set(agentId, { generation: 'log-1', events: [], listeners: new Set() })
      const conversation: StudioCreatedConversation = {
        workspaceId: 'ws-1',
        agentId,
        sessionId: 'session-2',
        name: request.name ?? 'New chat',
        cli: request.cli ?? 'claude-code',
        providerId: 'claude-agent',
        modelId: request.model ?? 'default',
        ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
      }
      created.set(launchCommandId, conversation)
      return { ok: true, conversation }
    },
    // The real backend's rule, so a test reads what a client is shown.
    redact: (value) => redactConversationValue(value),
  }
  return backend
}

export type FakeAuthenticator = StudioAuthenticator & {
  grants: Map<string, StudioGrant>
  tokens: Map<string, string>
  pairingCodes: Map<string, StudioGrant>
  revoke(clientId: string): void
  change(clientId: string, grant: Partial<StudioGrant>): void
}

export const OWNER_TOKEN = 'owner_token_0123456789abcdef'

export function createFakeAuthenticator(): FakeAuthenticator {
  const revoked = new Set<(clientId: string) => void>()
  const changed = new Set<(clientId: string) => void>()
  const auth: FakeAuthenticator = {
    grants: new Map(),
    tokens: new Map(),
    pairingCodes: new Map(),
    authenticate(credential) {
      if ('token' in credential) {
        if (credential.token === OWNER_TOKEN)
          return {
            ok: true,
            grant: { clientId: 'owner', name: 'Studio', owner: true, scopes: [...STUDIO_SCOPES], ceiling: 'bypass' },
          }
        const clientId = auth.tokens.get(credential.token)
        const grant = clientId ? auth.grants.get(clientId) : undefined
        return grant ? { ok: true, grant } : { ok: false, message: 'This app is not paired with Studio.' }
      }
      const grant = auth.pairingCodes.get(credential.pairingCode)
      if (!grant) return { ok: false, message: 'That pairing code is not valid.' }
      auth.pairingCodes.delete(credential.pairingCode)
      const token = `sest_paired_${grant.clientId}_000000`
      auth.grants.set(grant.clientId, grant)
      auth.tokens.set(token, grant.clientId)
      return { ok: true, grant, pairingToken: token }
    },
    grantFor: (clientId) =>
      clientId === 'owner'
        ? { clientId: 'owner', name: 'Studio', owner: true, scopes: [...STUDIO_SCOPES], ceiling: 'bypass' }
        : (auth.grants.get(clientId) ?? null),
    onRevoked(listener) {
      revoked.add(listener)
      return () => revoked.delete(listener)
    },
    onGrantChanged(listener) {
      changed.add(listener)
      return () => changed.delete(listener)
    },
    revoke(clientId) {
      auth.grants.delete(clientId)
      for (const listener of revoked) listener(clientId)
    },
    change(clientId, patch) {
      auth.grants.set(clientId, { ...auth.grants.get(clientId)!, ...patch })
      for (const listener of changed) listener(clientId)
    },
  }
  return auth
}

/** Pair a client in the fake authenticator; returns its token. */
export function pairFakeClient(
  auth: FakeAuthenticator,
  clientId: string,
  scopes: StudioGrant['scopes'],
  ceiling: ConversationWirePermissionPreset = 'auto',
): string {
  const token = `sest_${clientId}_0123456789abcdef`
  auth.grants.set(clientId, { clientId, name: clientId, owner: false, scopes, ceiling })
  auth.tokens.set(token, clientId)
  return token
}

/** A raw client: writes lines, reads parsed frames (chunks reassembled). */
export type LineClient = {
  socket: Socket
  send(frame: unknown): void
  /** The next frame matching `match`, skipping earlier ones (kept for `next`). */
  next(match?: (frame: StudioParsedServerFrame) => boolean, timeoutMs?: number): Promise<StudioParsedServerFrame>
  frames: StudioParsedServerFrame[]
  closed: Promise<void>
  close(): void
}

export async function connectLineClient(path: string): Promise<LineClient> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.on('error', () => undefined)
  const frames: StudioParsedServerFrame[] = []
  const waiters: Array<() => void> = []
  const assembler = createStudioChunkAssembler()
  let buffer = ''
  const accept = (value: unknown) => {
    const frame = parseStudioServerFrame(value)
    if (!frame) throw new Error(`Unreadable frame: ${JSON.stringify(value).slice(0, 200)}`)
    if (frame.t === 'chunk') {
      const step = assembler.push(frame)
      if (step.kind === 'error') throw new Error(step.message)
      if (step.kind === 'frame') accept(JSON.parse(step.json))
      return
    }
    frames.push(frame)
    for (const wake of waiters.splice(0)) wake()
  }
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) accept(JSON.parse(line))
      newline = buffer.indexOf('\n')
    }
  })
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  return {
    socket,
    frames,
    closed,
    send: (frame) => socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`),
    async next(match = () => true, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = frames.findIndex(match)
        if (index !== -1) return frames.splice(index, 1)[0]
        if (Date.now() > deadline) throw new Error(`No matching frame; saw ${JSON.stringify(frames).slice(0, 400)}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    },
    close: () => socket.destroy(),
  }
}

export function hello(auth: { token: string } | { pairingCode: string }, extra: Record<string, unknown> = {}) {
  return { t: 'hello', protocolVersion: 1, client: { name: 'test-app' }, auth, ...extra }
}

/** A server on a fresh temp data directory, torn down with `dispose`. */
export async function startTestServer(
  input: {
    backend?: FakeBackend
    auth?: FakeAuthenticator
    helloTimeoutMs?: number
    maxConnections?: number
    maxConnectionsPerClient?: number
  } = {},
): Promise<{
  server: StudioRpcServer
  backend: FakeBackend
  auth: FakeAuthenticator
  audit: StudioAuditEntry[]
  dataDir: string
  path: string
  dispose(): Promise<void>
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-rpc-'))
  const backend = input.backend ?? createFakeBackend()
  const auth = input.auth ?? createFakeAuthenticator()
  const audit: StudioAuditEntry[] = []
  const server = createStudioRpcServer({
    dataDir,
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend,
    authenticator: auth,
    audit: (entry) => audit.push(entry),
    resyncRetryAfterMs: () => 1_500,
    ...(input.helloTimeoutMs ? { helloTimeoutMs: input.helloTimeoutMs } : {}),
    ...(input.maxConnections ? { maxConnections: input.maxConnections } : {}),
    ...(input.maxConnectionsPerClient ? { maxConnectionsPerClient: input.maxConnectionsPerClient } : {}),
  })
  await server.start()
  return {
    server,
    backend,
    auth,
    audit,
    dataDir,
    path: server.socketPath()!,
    async dispose() {
      await server.stop()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
