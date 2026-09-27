import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionFrame } from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { FleetConversationFrame, FleetConversationKey } from '../../shared/tailnet-fleet'
import { ConversationRuntime } from '../conversation-runtime'
import type { ConversationProviderAdapter } from '../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet/tailnet-conversation-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetFleetService, type TailnetFleetService } from './tailnet/tailnet-fleet-service'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { createRemoteConversations } from './tailnet/tailnet-remote-conversations'
import {
  createRemoteConversationCache,
  type RemoteConversationCache,
} from './tailnet/tailnet-remote-conversation-cache'
import type { RemoteTerminalSocketHandlers } from './tailnet/tailnet-remote-client'
import { pairingUrl } from './tailnet/tailnet-service'

// Another Studio desktop following this machine's conversations over the
// tailnet. Both halves are real: the gateway, its conversation socket, the
// session API and a conversation runtime on one side; the fleet service's
// conversation client, its kept copy on disk, and the real outbound socket on
// the other, over loopback TCP.

/** A provider whose turn streams whatever the test pushes, so a link can drop mid-reply. */
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started: () => void = () => undefined
  let turnStarted = new Promise<void>((resolve) => (started = resolve))
  const base = createMockConversationProvider()
  const adapter: ConversationProviderAdapter = {
    ...base,
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
        yield event('turn_started', { turnId: input.turnId })
        started()
        for (;;) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          const text = queue.shift()!
          if (text === null) break
          yield event('content_delta', { turnId: input.turnId, text })
        }
        yield event('turn_completed', { turnId: input.turnId })
      })(),
  }
  return {
    adapter,
    turnStarted: () => turnStarted,
    nextTurn: () => (turnStarted = new Promise<void>((resolve) => (started = resolve))),
    push: (text: string | null) => push(text),
  }
}

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
  fleet: TailnetFleetService
  newFleet(): TailnetFleetService
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
  const newFleet = () =>
    createTailnetFleetService({
      resolveUserDataDir: () => localDir,
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
    permissionPreset: 'manual',
  })
  assert.ok(started.ok)
  const harness: Harness = {
    runtime,
    provider,
    devices,
    localDir,
    sessionId: started.session.sessionId,
    joins,
    fleet: newFleet(),
    newFleet,
    async pair(scopes) {
      const offer = devices.offerPairing({ scopes })
      const result = await harness.fleet.pair({ pairingUrl: pairingUrl('127.0.0.1', port, offer.token) })
      assert.ok(result.ok, result.ok ? '' : result.message)
      return result.connection.id
    },
    stopServer: () => server.stop(),
    async restartServer() {
      server = build(port)
      await server.start()
    },
    async close() {
      harness.fleet.shutdown()
      await server.stop().catch(() => undefined)
      await runtime.shutdown()
      for (const dir of [workspaceRoot, remoteDir, localDir]) rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}

/** Everything one window was handed for a followed conversation. */
function follower(fleet: TailnetFleetService, key: FleetConversationKey, followId = 'pane-1') {
  const frames: FleetConversationFrame[] = []
  const following = fleet.followConversation({ followId, key, turnLimit: 10, emit: (frame) => frames.push(frame) })
  const of = <T extends FleetConversationFrame['type']>(type: T) =>
    frames.filter((frame): frame is Extract<FleetConversationFrame, { type: T }> => frame.type === type)
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
    const listed = await h.fleet.listConversations(connectionId)
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.equal(listed.access, 'operate')
    assert.deepEqual(
      listed.conversations.map((entry) => [entry.workspaceId, entry.agentId, entry.sessionId]),
      [[workspaceId, agentId, h.sessionId]],
    )

    const key = { connectionId, workspaceId, agentId }
    const pane = follower(h.fleet, key)
    assert.deepEqual(await pane.following, { ok: true })
    await waitFor(pane.live, 'the follow synchronizes and goes live')
    assert.equal(pane.of('snapshot').length, 1, 'a first follow is hydrated by one snapshot')

    // A send from this desktop starts a turn over there.
    // It is answered when the turn ends, as a send on the desktop itself is.
    const sent = h.fleet.conversationCommand({ key, command: { kind: 'send', message: 'stream' } })
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
  } finally {
    await h.close()
  }
})

test('a restarted client shows its kept copy at once and resumes from its cursor; a new generation resets it', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read', 'conversation:operate'])
    const key = { connectionId, workspaceId, agentId }
    const first = follower(h.fleet, key)
    await waitFor(first.live, 'first follow goes live')
    const sent = h.fleet.conversationCommand({ key, command: { kind: 'send', message: 'one' } })
    await h.provider.turnStarted()
    h.provider.push('kept ')
    h.provider.push(null)
    assert.deepEqual(await sent, { ok: true })
    await waitFor(() => first.of('event').some((frame) => frame.event.type === 'turn_completed'), 'first turn lands')
    const heldThrough = Math.max(...first.seqs())
    h.fleet.shutdown()

    // Offline: another turn happens over there.
    h.provider.nextTurn()
    const sending = h.runtime.sendTurn({ sessionId: h.sessionId, message: 'two' })
    await h.provider.turnStarted()
    h.provider.push('missed ')
    h.provider.push(null)
    await sending

    // A fresh process: nothing in memory, the copy on disk.
    h.fleet = h.newFleet()
    const joinsBefore = h.joins.length
    const second = follower(h.fleet, key, 'pane-2')
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
    h.fleet.shutdown()

    // The copy now names a log generation the far end no longer has.
    const directory = join(h.localDir, 'tailnet-remote-conversations')
    const [file] = readdirSync(directory)
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record<string, unknown>
    writeFileSync(join(directory, file), JSON.stringify({ ...record, generation: 'a-recreated-log' }))
    h.fleet = h.newFleet()
    const third = follower(h.fleet, key, 'pane-3')
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
    const pane = follower(h.fleet, key)
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'operate')

    h.devices.updateDeviceScopes(deviceId, ['conversation:read'])
    const refused = await h.fleet.conversationCommand({ key, command: { kind: 'interrupt' } })
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.code, 'conversation_operate_required')
    assert.equal(pane.link()?.access, 'read', 'the window learns it is read-only')
    // Known to be read-only now: refused here, without a round trip.
    const again = await h.fleet.conversationCommand({ key, command: { kind: 'send', message: 'hi' } })
    assert.equal(!again.ok && again.code, 'conversation_operate_required')

    // A permanent rule is refused before it leaves this machine.
    const always = await h.fleet.conversationCommand({
      key,
      command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
    })
    assert.equal(!always.ok && always.code, 'unsafe_remote_decision')

    const joins = h.joins.length
    h.devices.updateDeviceScopes(deviceId, ['terminal:observe'])
    await waitFor(() => pane.link()?.state === 'closed', 'losing read closes the follow')
    assert.equal(pane.link()?.code, 'conversation_scope_required')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(h.joins.length, joins, 'and it does not dial again')

    const listed = await h.fleet.listConversations(connectionId)
    assert.equal(!listed.ok && listed.code, 'conversation_scope_required')
  } finally {
    await h.close()
  }
})

test('a revoked pairing ends the follow and is recorded as unauthorized', async () => {
  const h = await startHarness()
  try {
    const connectionId = await h.pair(['conversation:read'])
    const pane = follower(h.fleet, { connectionId, workspaceId, agentId })
    await waitFor(pane.live, 'follow goes live')
    assert.equal(pane.link()?.access, 'read')
    h.devices.revokeDevice(h.devices.listDevices()[0].id)
    await waitFor(() => pane.link()?.state === 'closed', 'revocation closes the follow')
    assert.equal(pane.link()?.code, 'revoked')
    const reach = h.fleet.getLiveState().reachability.find((entry) => entry.connectionId === connectionId)
    assert.equal(reach?.unauthorized, true)
  } finally {
    await h.close()
  }
})

test('a resync close waits the delay the far end advised before dialling again', async () => {
  const dials: number[] = []
  const handlers: RemoteTerminalSocketHandlers[] = []
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
  const frames: FleetConversationFrame[] = []
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
  const handlers: RemoteTerminalSocketHandlers[] = []
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
  const frames: FleetConversationFrame[] = []
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
  const handlers: RemoteTerminalSocketHandlers[] = []
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
  const frames: FleetConversationFrame[] = []
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
  handlers[0].onFrame({ type: 'synchronized', seq: 5, generation: 'g1' })
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
