import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { createSecretCipherStandIn } from '../../../tests/stubs/secret-cipher'

import type { ConversationEvent, ConversationSessionFrame } from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { MeshConversationFrame, MeshConversationKey } from '../../shared/tailnet-mesh'
import { ConversationRuntime } from '../conversation-runtime'
import type { ConversationProviderAdapter } from '../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet/tailnet-conversation-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet/tailnet-mesh-service'
import { createTailnetMeshStore } from './tailnet/tailnet-mesh-store'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { createRemoteConversations } from './tailnet/tailnet-remote-conversations'
import {
  createRemoteConversationCache,
  type RemoteConversationCache,
} from './tailnet/tailnet-remote-conversation-cache'
import type { RemoteJsonSocket, RemoteJsonSocketHandlers } from './tailnet/tailnet-remote-client'
import { pairingUrl } from './tailnet/tailnet-service'

// Another Studio desktop following this machine's conversations over the
// tailnet. Both halves are real: the gateway, its conversation socket, the
// session API and a conversation runtime on one side; the mesh service's
// conversation client, its kept copy on disk, and the real outbound socket on
// the other, over loopback TCP.

/** A provider whose turn streams whatever the test pushes, so a link can drop mid-reply. */
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started: () => void = () => undefined
  let turnStarted = new Promise<void>((resolve) => (started = resolve))
  let running = false
  const switched: string[] = []
  // A CLI chat provider takes a new model mid-conversation; mid-turn it says
  // the reply finishes on the model it started with, as the real ones do.
  const base = createMockConversationProvider({ liveModelSwitch: true })
  const adapter: ConversationProviderAdapter = {
    ...base,
    listModels: () => ['mock-model', 'mock-large'],
    setPermissionPreset: async () => ({ ok: true }),
    setModel: async (input) => {
      switched.push(input.nextModelId)
      return running ? { ok: true, notice: MID_TURN_NOTICE } : { ok: true }
    },
    sendTurn: (input) =>
      (async function* () {
        const queue: Array<string | null> = []
        let wake: (() => void) | null = null
        push = (text) => {
          queue.push(text)
          wake?.()
        }
        const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 1,
          type,
          payload,
        })
        running = true
        yield event('turn_started', { turnId: input.turnId })
        started()
        for (;;) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          const text = queue.shift()!
          if (text === null) break
          yield event('content_delta', { turnId: input.turnId, text })
        }
        running = false
        yield event('turn_completed', { turnId: input.turnId })
      })(),
  }
  return {
    adapter,
    switched,
    turnStarted: () => turnStarted,
    nextTurn: () => (turnStarted = new Promise<void>((resolve) => (started = resolve))),
    push: (text: string | null) => push(text),
  }
}

const MID_TURN_NOTICE = 'The new model starts with your next message.'

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

type Harness = {
  runtime: ConversationRuntime
  provider: ReturnType<typeof pushProvider>
  devices: TailnetDeviceStore
  localDir: string
  sessionId: string
  /** What the session API handed the gateway for each subscribe: the cursor asked with, and the frames produced. */
  joins: Array<{ afterSeq?: number; generation?: string; frames: ConversationSessionFrame[] }>
  mesh: TailnetMeshService
  newMesh(): TailnetMeshService
  pair(scopes: TailnetScope[]): Promise<string>
  stopServer(): Promise<void>
  restartServer(): Promise<void>
  close(): Promise<void>
}

const workspaceId = 'workspace'
const agentId = 'agent'

async function startHarness(): Promise<Harness> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'remote-conversation-host-'))
  const remoteDir = mkdtempSync(join(tmpdir(), 'remote-conversation-devices-'))
  const localDir = mkdtempSync(join(tmpdir(), 'remote-conversation-local-'))
  const provider = pushProvider()
  const runtime = new ConversationRuntime({ adapters: [provider.adapter], getProviderById: () => undefined })
  const real = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    () => 'bypass',
    () => null,
    // The chat's CLI catalog, as the host's own picker would list it.
    async (providerId) =>
      providerId === provider.adapter.id
        ? {
            cli: 'mock-cli',
            cliLabel: 'Mock CLI',
            options: [
              { id: 'mock-model', label: 'Mock' },
              { id: 'mock-large', label: 'Mock Large' },
            ],
          }
        : null,
  )
  const joins: Harness['joins'] = []
  const conversations: ConversationGatewayHost = {
    ...real,
    subscribe(key, cursor, listener) {
      const join = {
        afterSeq: cursor.afterSeq,
        generation: cursor.generation,
        frames: [] as ConversationSessionFrame[],
      }
      joins.push(join)
      return real.subscribe(key, cursor, (frame) => {
        join.frames.push(frame)
        listener(frame)
      })
    },
  }
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => remoteDir })
  const build = (port: number): TailnetGatewayServer =>
    createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => [],
      isMutation: () => false,
      devices,
      conversations,
      peers: createTailnetPeerResolver({ runWhois: async () => null }),
    })
  let server = build(0)
  await server.start()
  const port = server.address()!.port
  // One keychain across launches, so a restarted client opens the pairing the
  // first one sealed.
  const keychain = createSecretCipherStandIn()
  const newMesh = () =>
    createTailnetMeshService({
      resolveUserDataDir: () => localDir,
      createStore: (options) => createTailnetMeshStore({ ...options, cipher: keychain }),
      resolveDeviceName: () => 'dev-macbook-air',
      resolvePeerName: async () => null,
      conversations: { retry: { baseMs: 20, maxMs: 200 }, saveDelayMs: 5, requestTimeoutMs: 5_000 },
    })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.adapter.id,
    modelId: provider.adapter.listModels()[0],
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const harness: Harness = {
    runtime,
    provider,
    devices,
    localDir,
    sessionId: started.session.sessionId,
    joins,
    mesh: newMesh(),
    newMesh,
    async pair(scopes) {
      const offer = devices.offerPairing({ scopes })
      const result = await harness.mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
      assert.ok(result.ok, result.ok ? '' : result.message)
      return result.connection.id
    },
    stopServer: () => server.stop(),
    async restartServer() {
      server = build(port)
      await server.start()
    },
    async close() {
      harness.mesh.shutdown()
      await server.stop().catch(() => undefined)
      await runtime.shutdown()
      for (const dir of [workspaceRoot, remoteDir, localDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}

/** Everything one window was handed for a followed conversation. */
function follower(mesh: TailnetMeshService, key: MeshConversationKey, followId = 'pane-1') {
  const frames: MeshConversationFrame[] = []
  const following = mesh.followConversation({ followId, key, turnLimit: 10, emit: (frame) => frames.push(frame) })
  const of = <T extends MeshConversationFrame['type']>(type: T) =>
    frames.filter((frame): frame is Extract<MeshConversationFrame, { type: T }> => frame.type === type)
  return {
    frames,
    following,
    of,
    text: () =>
      of('event')
        .flatMap((frame) => (frame.event.type === 'content_delta' ? [String(frame.event.payload?.text)] : []))
        .join(''),
    seqs: () => of('event').map((frame) => frame.event.seq!),
    live: () => frames.some((frame) => frame.type === 'link' && frame.state === 'live'),
    link: () => of('link').at(-1),
  }
}

test('a paired desktop lists, follows and drives a conversation, and a dropped link resumes without a reset', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.access, 'operate')
    assert.deepEqual(
      listed.conversations.map((entry) => [entry.workspaceId, entry.agentId, entry.sessionId, entry.permissionPreset]),
      [[workspaceId, agentId, h.sessionId, 'bypass']],
      'the list carries the preset in force, across the wire',
    )

    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    assert.deepEqual(await pane.following, { ok: true })
    await waitFor(pane.live, 'the follow synchronizes and goes live')
    assert.equal(pane.of('snapshot').length, 1, 'a first follow is hydrated by one snapshot')

    // A send from this desktop starts a turn over there, on a chat in Bypass.
    // It is answered when the turn ends, as a send on the desktop itself is.
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    for (let index = 0; index < 5; index++) h.provider.push(`before-${index} `)
    await waitFor(() => pane.text().endsWith('before-4 '), 'live deltas reach the follower')
    const lastBefore = Math.max(...pane.seqs())

    // The link drops mid-reply; more of the reply lands and reaches nobody.
    const joinsBefore = h.joins.length
    await h.stopServer()
    await waitFor(() => pane.link()?.state !== 'live', 'the follower notices the drop')
    for (let index = 0; index < 5; index++) h.provider.push(`missed-${index} `)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.restartServer()
    await waitFor(() => h.joins.length > joinsBefore && pane.link()?.state === 'live', 'the follower reconnects')
    for (let index = 0; index < 3; index++) h.provider.push(`after-${index} `)
    h.provider.push(null)
    await waitFor(
      () => pane.of('event').some((frame) => frame.event.type === 'turn_completed'),
      'the rest of the turn arrives',
    )
    assert.deepEqual(await sent, { ok: true }, 'a send in flight across the drop is settled once, by its receipt')

    const rejoin = h.joins.at(-1)!
    assert.equal(rejoin.afterSeq !== undefined && rejoin.afterSeq >= lastBefore, true, 'the reconnect names its cursor')
    assert.ok(rejoin.generation, 'with the generation it was read from')
    assert.equal(
      rejoin.frames.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the far end can vouch for gets no snapshot',
    )
    assert.equal(pane.of('snapshot').length, 1, 'the window was never reset')
    const seqs = pane.seqs()
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    )
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicates')
    const expected = ['before', 'missed', 'after']
      .flatMap((phase) => Array.from({ length: phase === 'after' ? 3 : 5 }, (_, index) => `${phase}-${index} `))
      .join('')
    assert.equal(pane.text(), expected, 'every delta exactly once, across the drop')

    // And this desktop can switch the chat over there to No flag, and back.
    for (const preset of ['none', 'bypass'] as const) {
      assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setPermissionPreset', preset } }), {
        ok: true,
      })
      const relisted = await h.mesh.listConversations(connectionId)
      assert.ok(relisted.ok)
      assert.equal(relisted.conversations[0]?.permissionPreset, preset)
    }
  } finally {
    await h.close()
  }
})

test("a paired desktop switches a chat's model within its CLI, and the host's session and list follow", async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const listed = await h.mesh.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.modelSwitch, true, 'the host advertises model switching')
    assert.deepEqual(
      listed.conversations[0]?.models,
      {
        cli: 'mock-cli',
        cliLabel: 'Mock CLI',
        liveModelSwitch: true,
        options: [
          { id: 'mock-model', label: 'Mock' },
          { id: 'mock-large', label: 'Mock Large' },
        ],
      },
      'the list carries the catalog across the wire',
    )
    assert.equal(listed.conversations[0]?.modelId, 'mock-model')

    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'the follow goes live')

    // Between turns the switch simply applies.
    assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'mock-large' } }), {
      ok: true,
    })
    assert.deepEqual(h.provider.switched, ['mock-large'])
    const hostSession = h.runtime.listSessions({ workspaceId, agentId })
    assert.ok(hostSession.ok)
    assert.equal(hostSession.sessions[0]?.modelId, 'mock-large', "the host's session is on the new model")
    const relisted = await h.mesh.listConversations(connectionId)
    assert.ok(relisted.ok)
    assert.equal(relisted.conversations[0]?.modelId, 'mock-large', 'and the list names it')
    await waitFor(
      () => pane.of('event').some((frame) => frame.event.type === 'session_updated'),
      "the follower sees the host's own record of the switch",
    )

    // Mid-turn, the answer says the switch applies from the next turn.
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
    await h.provider.turnStarted()
    assert.deepEqual(await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'default' } }), {
      ok: true,
      notice: MID_TURN_NOTICE,
    })
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })

    // A model the CLI does not offer is refused by the host with its own code.
    const refused = await h.mesh.conversationCommand({ key, command: { kind: 'setModel', modelId: 'gpt-large' } })
    assert.equal(!refused.ok && refused.code, 'unsupported_model')
    assert.deepEqual(h.provider.switched, ['mock-large', 'default'])
  } finally {
    await h.close()
  }
})

test('a restarted client shows its kept copy at once and resumes from its cursor; a new generation resets it', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const key = { connectionId, workspaceId, agentId }
    const first = follower(h.mesh, key)
    await waitFor(first.live, 'first follow goes live')
    const sent = h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'one' } })
    await h.provider.turnStarted()
    h.provider.push('kept ')
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })
    await waitFor(() => first.of('event').some((frame) => frame.event.type === 'turn_completed'), 'first turn lands')
    const heldThrough = Math.max(...first.seqs())
    h.mesh.shutdown()

    // Offline: another turn happens over there.
    h.provider.nextTurn()
    const sending = h.runtime.sendTurn({ sessionId: h.sessionId, message: 'two' })
    await h.provider.turnStarted()
    h.provider.push('missed ')
    h.provider.push(null)
    await sending

    // A fresh process: nothing in memory, the copy on disk.
    h.mesh = h.newMesh()
    const joinsBefore = h.joins.length
    const second = follower(h.mesh, key, 'pane-2')
    await second.following
    const cached = second.of('snapshot')[0]
    assert.ok(cached, 'the kept copy is handed over at once')
    assert.equal(cached.reset, undefined)
    assert.ok(
      cached.page.events.some((event) => event.type === 'content_delta' && event.payload?.text === 'kept '),
      'with what was followed before the restart',
    )
    await waitFor(second.live, 'the restarted client resumes')
    await waitFor(() => second.text().includes('missed '), 'the missed turn arrives')
    const rejoin = h.joins.slice(joinsBefore).at(-1)!
    assert.ok(rejoin.afterSeq !== undefined && rejoin.afterSeq >= heldThrough, 'resumed from the persisted cursor')
    assert.equal(
      rejoin.frames.some((frame) => frame.type === 'snapshot'),
      false,
      'incrementally, with no snapshot',
    )
    assert.equal(second.of('snapshot').length, 1, 'only the kept copy hydrated the window')
    assert.ok(
      second.seqs().every((seq) => seq > heldThrough),
      'nothing already held arrives twice',
    )
    h.mesh.shutdown()

    // The copy now names a log generation the far end no longer has.
    const directory = join(h.localDir, 'tailnet-remote-conversations')
    const [file] = readdirSync(directory)
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record<string, unknown>
    writeFileSync(join(directory, file), JSON.stringify({ ...record, generation: 'a-recreated-log' }))
    h.mesh = h.newMesh()
    const third = follower(h.mesh, key, 'pane-3')
    await waitFor(() => third.of('snapshot').some((frame) => frame.reset === true), 'another generation resets')
    const reset = third.of('snapshot').find((frame) => frame.reset === true)!
    assert.ok(reset.generation && reset.generation !== 'a-recreated-log', 'the reset names the live generation')
    assert.ok(
      reset.page.events.some((event) => event.payload?.text === 'missed '),
      'and replaces the copy',
    )
    await waitFor(third.live, 'and goes live after the reset')
  } finally {
    await h.close()
  }
})

test('a grant narrowed to read refuses commands; one without read ends the follow for good', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const deviceId = h.devices.listDevices()[0].id
    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.mesh, key)
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'operate')

    h.devices.updateDeviceScopes(deviceId, ['conversation:read'])
    const refused = await h.mesh.conversationCommand({ key, command: { kind: 'interrupt' } })
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.code, 'conversation_operate_required')
    assert.equal(pane.link()?.access, 'read', 'the window learns it is read-only')
    // Known to be read-only now: refused here, without a round trip.
    const again = await h.mesh.conversationCommand({ key, command: { kind: 'send', message: 'hi' } })
    assert.equal(!again.ok && again.code, 'conversation_operate_required')

    // A permanent rule is refused before it leaves this machine.
    const always = await h.mesh.conversationCommand({
      key,
      command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
    })
    assert.equal(!always.ok && always.code, 'unsafe_remote_decision')

    const joins = h.joins.length
    h.devices.updateDeviceScopes(deviceId, ['workspace:read'])
    await waitFor(() => pane.link()?.state === 'closed', 'losing read closes the follow')
    assert.equal(pane.link()?.code, 'conversation_scope_required')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(h.joins.length, joins, 'and it does not dial again')

    const listed = await h.mesh.listConversations(connectionId)
    assert.equal(!listed.ok && listed.code, 'conversation_scope_required')
  } finally {
    await h.close()
  }
})

test('a revoked pairing ends the follow and is recorded as unauthorized', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read'])
    const pane = follower(h.mesh, { connectionId, workspaceId, agentId })
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'read')
    h.devices.revokeDevice(h.devices.listDevices()[0].id)
    await waitFor(() => pane.link()?.state === 'closed', 'revocation closes the follow')
    assert.equal(pane.link()?.code, 'revoked')
    const reach = h.mesh.getLiveState().reachability.find((entry) => entry.connectionId === connectionId)
    assert.equal(reach?.unauthorized, true)
  } finally {
    await h.close()
  }
})

test('a resync close waits the delay the far end advised before dialling again', async () => {
  const dials: number[] = []
  const handlers: RemoteJsonSocketHandlers[] = []
  const cache: RemoteConversationCache = {
    load: async () => null,
    save: async () => undefined,
    saveNow: () => undefined,
    forgetConnection: async () => undefined,
  }
  const client = createRemoteConversations({
    cache,
    retry: { baseMs: 5, maxMs: 10 },
    resolveConnection: () => ({
      id: 'c',
      machineName: 'mac-mini',
      endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read'],
    }),
    openSocket: async (input) => {
      dials.push(Date.now())
      handlers.push(input.handlers)
      return { ok: true, value: { send: () => undefined, close: () => undefined, isOpen: () => true } }
    },
  })
  const frames: MeshConversationFrame[] = []
  await client.follow({
    followId: 'pane',
    key: { connectionId: 'c', workspaceId, agentId },
    emit: (frame) => frames.push(frame),
  })
  await waitFor(() => dials.length === 1, 'first dial')
  handlers[0].onFrame({ type: 'error', code: 'resync_required', message: 'behind', retryAfterMs: 400 })
  handlers[0].onClosed({ code: 4409, reason: 'resync_required;retryAfterMs=400' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(dials.length, 1, 'no dial before the advised delay, whatever the backoff says')
  client.onWake()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(dials.length, 1, 'a wake does not cut an advised delay short')
  await waitFor(() => dials.length === 2, 'dials again once the delay has passed')
  assert.ok(dials[1] - dials[0] >= 390, `waited ${dials[1] - dials[0]} ms`)
  client.shutdown()
})

test('a frame of a known type in the wrong shape ends the follow instead of being skipped', async () => {
  const handlers: RemoteJsonSocketHandlers[] = []
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async () => undefined,
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    resolveConnection: () => ({
      id: 'c',
      machineName: 'build-box',
      endpoint: { host: 'build-box.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      return { ok: true, value: { send: () => undefined, close: () => undefined, isOpen: () => true } }
    },
  })
  const frames: MeshConversationFrame[] = []
  await client.follow({ followId: 'p', key: { connectionId: 'c', workspaceId, agentId }, emit: (f) => frames.push(f) })
  await waitFor(() => handlers.length === 1, 'dialled')
  // A newer desktop's frame type is ignored.
  handlers[0].onFrame({ type: 'presence', who: 'someone' })
  const before = frames.at(-1)
  assert.equal(before?.type === 'link' && before.state, 'connecting')
  handlers[0].onFrame({ type: 'event', event: { id: 'e', seq: 'twelve' } })
  const last = frames.at(-1)
  assert.equal(last?.type === 'link' && last.state, 'closed')
  assert.equal(last?.type === 'link' && last.code, 'protocol')
  client.shutdown()
})

test('a snapshot sent in parts and chunks is applied once whole, and a busy command is retried under its own id', async () => {
  const handlers: RemoteJsonSocketHandlers[] = []
  const sent: Array<Record<string, unknown>> = []
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async () => undefined,
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    retry: { baseMs: 5, maxMs: 10 },
    resolveConnection: () => ({
      id: 'c',
      machineName: 'mac-mini',
      endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read', 'conversation:operate'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      return { ok: true, value: { send: (frame) => sent.push(frame), close: () => undefined, isOpen: () => true } }
    },
  })
  const frames: MeshConversationFrame[] = []
  const key = { connectionId: 'c', workspaceId, agentId }
  await client.follow({ followId: 'p', key, emit: (f) => frames.push(f) })
  await waitFor(() => handlers.length === 1, 'dialled')
  const event = (seq: number, text: string) => ({
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId,
    agentId,
    providerId: 'p',
    modelId: 'm',
    type: 'content_delta',
    createdAt: 1,
    payload: { text, turnId: 't' },
  })
  const part = (index: number, events: unknown[]) => ({
    type: 'snapshot',
    page: { events, hasMore: false, beforeCursor: null },
    generation: 'g1',
    part: { index, total: 2 },
  })
  handlers[0].onFrame(part(0, [event(1, 'a'), event(2, 'b')]))
  assert.equal(frames.filter((frame) => frame.type === 'snapshot').length, 0, 'nothing is applied from half a snapshot')
  // The second part is larger than one frame, so it arrives as chunks.
  const json = JSON.stringify(part(1, [event(5, 'c')]))
  const pieces = [json.slice(0, 40), json.slice(40, 90), json.slice(90)]
  pieces.forEach((piece, index) =>
    handlers[0].onFrame({ type: 'chunk', frameId: 'f1', index, total: pieces.length, json: piece }),
  )
  const snapshots = frames.filter((frame) => frame.type === 'snapshot')
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0].type === 'snapshot' && snapshots[0].page.events.map((entry) => entry.seq), [1, 2, 5])
  // A fence for another conversation — the tail of a replay the host was
  // switching away from — is never taken as this one's cursor.
  handlers[0].onFrame({ type: 'synchronized', seq: 99, generation: 'gx', key: { workspaceId, agentId: 'other' } })
  assert.equal(frames.filter((frame) => frame.type === 'synchronized').length, 0)
  handlers[0].onFrame({ type: 'synchronized', seq: 5, generation: 'g1', key: { workspaceId, agentId } })
  assert.equal(frames.filter((frame) => frame.type === 'synchronized').length, 1)
  // Sequence 6 and 7 never arrive on their own: 8 is a merged run. A gap is
  // normal and never a reason to resubscribe.
  handlers[0].onFrame({ type: 'event', event: event(8, 'd') })
  assert.equal(sent.filter((frame) => frame.type === 'subscribe').length, 1)
  assert.equal(frames.at(-1)?.type, 'event')

  const result = client.command(key, { kind: 'interrupt' })
  await waitFor(() => sent.some((frame) => frame.type === 'command'), 'the command is sent')
  const first = sent.find((frame) => frame.type === 'command')!
  handlers[0].onFrame({ type: 'commandResult', commandId: first.commandId, ok: false, code: 'busy', retryAfterMs: 20 })
  await waitFor(() => sent.filter((frame) => frame.type === 'command').length === 2, 'retried after the delay')
  const second = sent.filter((frame) => frame.type === 'command')[1]
  assert.equal(second.commandId, first.commandId, 'under the same command id')
  handlers[0].onFrame({ type: 'commandResult', commandId: first.commandId, ok: true })
  assert.deepEqual(await result, { ok: true })

  // A read the far end refuses as too large is answered, and the follow stays up.
  const detail = client.toolDetail(key, 'tool-1')
  await waitFor(() => sent.some((frame) => frame.type === 'getToolDetail'), 'the read is sent')
  const read = sent.find((frame) => frame.type === 'getToolDetail')!
  handlers[0].onFrame({ type: 'result', requestId: read.requestId, ok: false, code: 'too_large', message: 'Too big.' })
  assert.deepEqual(await detail, { ok: false, code: 'unavailable', message: 'Too big.' })
  client.shutdown()
})

test('a kept copy read back while its write is in flight is the copy that write leaves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-conversation-cache-'))
  try {
    const cache = createRemoteConversationCache({ resolveUserDataDir: () => dir })
    const cacheKey = { connectionId: 'c', workspaceId, agentId }
    const page = (text: string) => ({
      events: [
        {
          id: 'e1',
          seq: 7,
          sessionId: 's',
          workspaceId,
          agentId,
          providerId: 'p',
          modelId: 'm',
          type: 'content_delta' as const,
          createdAt: 1,
          payload: { text },
        },
      ],
      hasMore: false,
      beforeCursor: null,
    })
    await cache.save(cacheKey, { generation: 'g', lastSeq: 7, page: page('old') })
    void cache.save(cacheKey, { generation: 'g', lastSeq: 9, page: page('new') })
    const loaded = await cache.load(cacheKey)
    assert.equal(loaded?.lastSeq, 9)
    assert.equal(loaded?.page.events[0].payload?.text, 'new')
    // A copy for another conversation is never read as this one's.
    assert.equal(await cache.load({ ...cacheKey, agentId: 'other' }), null)
    await cache.forgetConnection('c')
    assert.equal(await cache.load(cacheKey), null, 'forgetting the machine deletes what was kept of it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A follow client whose sockets and kept copy the test drives, on fake timers. */
function drivenClient(overrides: { isOnBattery?: () => boolean; dial?: 'ok' | 'fail' } = {}) {
  const handlers: RemoteJsonSocketHandlers[] = []
  const sockets: Array<{ socket: RemoteJsonSocket; closed: boolean }> = []
  const saves: Array<{ lastSeq: number | null; events: number }> = []
  const away: string[] = []
  let dial = overrides.dial ?? 'ok'
  let release: (() => void) | null = null
  let hold = false
  const client = createRemoteConversations({
    cache: {
      load: async () => null,
      save: async (_key, record) => {
        saves.push({ lastSeq: record.lastSeq, events: record.page.events.length })
      },
      saveNow: () => undefined,
      forgetConnection: async () => undefined,
    },
    retry: { baseMs: 500, maxMs: 15_000 },
    ...(overrides.isOnBattery ? { isOnBattery: overrides.isOnBattery } : {}),
    onAway: (connectionId) => away.push(connectionId),
    resolveConnection: () => ({
      id: 'c',
      machineName: 'mac-mini',
      endpoint: { host: 'mac-mini.tail1234.ts.net', port: 1 },
      token: 't',
      scopes: ['conversation:read', 'conversation:operate'],
    }),
    openSocket: async (input) => {
      handlers.push(input.handlers)
      if (hold) await new Promise<void>((resolve) => (release = resolve))
      if (dial === 'fail') return { ok: false, code: 'unreachable', message: 'mac-mini did not answer.' }
      const entry = { closed: false, socket: null as unknown as RemoteJsonSocket }
      entry.socket = {
        send: () => undefined,
        close: () => {
          entry.closed = true
        },
        isOpen: () => !entry.closed,
      }
      sockets.push(entry)
      return { ok: true, value: entry.socket }
    },
  })
  const frames: MeshConversationFrame[] = []
  const key = { connectionId: 'c', workspaceId, agentId }
  const event = (seq: number, type: string, payload: Record<string, unknown> = { text: 'x', turnId: 't' }) => ({
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId,
    agentId,
    providerId: 'p',
    modelId: 'm',
    type,
    createdAt: 1,
    payload,
  })
  return {
    client,
    handlers,
    sockets,
    saves,
    away,
    frames,
    key,
    event,
    setDial: (next: 'ok' | 'fail') => (dial = next),
    holdDials: (next: boolean) => (hold = next),
    releaseDial: () => release?.(),
    follow: (followId = 'p') => client.follow({ followId, key, emit: (frame) => frames.push(frame) }),
    link: () => frames.filter((frame) => frame.type === 'link').at(-1),
    fence: (seq: number) =>
      handlers.at(-1)!.onFrame({ type: 'synchronized', seq, generation: 'g1', key: { workspaceId, agentId } }),
  }
}

test('a streaming reply is kept on a slow beat, and at once where a turn ends', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient()
    await d.follow()
    await vi.advanceTimersByTimeAsync(0)
    d.fence(1)
    assert.equal(d.saves.length, 1, 'the fence is kept at once')
    // A reply streaming for two seconds, four deltas a second.
    for (let seq = 2; seq < 10; seq++) {
      d.handlers[0].onFrame({ type: 'event', event: d.event(seq, 'content_delta') })
      await vi.advanceTimersByTimeAsync(250)
    }
    assert.equal(d.saves.length, 1, 'no write per delta')
    await vi.advanceTimersByTimeAsync(8_000)
    assert.equal(d.saves.length, 2, 'one write on the slow beat')
    assert.equal(d.saves.at(-1)?.lastSeq, 9)
    d.handlers[0].onFrame({ type: 'event', event: d.event(10, 'content_delta') })
    d.handlers[0].onFrame({ type: 'event', event: d.event(11, 'turn_completed', { turnId: 't' }) })
    assert.equal(d.saves.length, 3, 'the end of the turn is kept at once')
    assert.equal(d.saves.at(-1)?.lastSeq, 11)
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(d.saves.length, 3, 'nothing left to write')
    // A reconnect that finds nothing new rewrites nothing.
    d.handlers[0].onClosed({ code: null, reason: 'dropped' })
    await vi.advanceTimersByTimeAsync(1_000)
    d.fence(11)
    assert.equal(d.saves.length, 3, 'an unchanged fence is not a write')
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('on battery the slow beat stretches', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ isOnBattery: () => true })
    await d.follow()
    await vi.advanceTimersByTimeAsync(0)
    d.fence(1)
    d.handlers[0].onFrame({ type: 'event', event: d.event(2, 'content_delta') })
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(d.saves.length, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    assert.equal(d.saves.length, 2)
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a follow on a machine that stops answering parks until it is resumed or the machine wakes', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ dial: 'fail' })
    await d.follow()
    await vi.advanceTimersByTimeAsync(10_000)
    const dials = d.handlers.length
    assert.equal(dials, 4, 'the first dial and a few quick retries')
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'offline')
    assert.deepEqual(d.away, ['c'], 'the owner is told once')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    assert.equal(d.handlers.length, dials, 'a parked follow does not dial on a timer')
    assert.equal(d.client.parkedOn('c'), true)

    d.client.resume('c')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'resume dials once')
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'offline', 'and parks again on a failure')
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(d.handlers.length, dials + 1)
    await d.follow('another-window')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 2, 'another window opening it dials once')

    d.setDial('ok')
    d.client.onWake()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 3, 'a wake dials a parked follow')
    d.fence(1)
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'live')
    assert.equal(d.client.parkedOn('c'), false)
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})

test('a follow woken, resumed and joined while its dial is out opens one socket', async () => {
  vi.useFakeTimers()
  try {
    const d = drivenClient({ dial: 'fail' })
    await d.follow()
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(d.client.parkedOn('c'), true)
    const dials = d.handlers.length
    d.setDial('ok')
    d.holdDials(true)
    d.client.resume('c')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'the dial is out')
    // Everything else that would dial lands while it is out.
    d.client.onWake()
    d.client.resume('c')
    await d.follow('p2')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.handlers.length, dials + 1, 'none of it dials a second time')
    d.releaseDial()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(d.sockets.length, 1, 'one socket, none orphaned')
    d.fence(1)
    assert.equal(d.link()?.type === 'link' && d.link()?.state, 'live')
    d.client.shutdown()
  } finally {
    vi.useRealTimers()
  }
})
