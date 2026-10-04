import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type {
  StudioCallFrame,
  StudioCancelFrame,
  StudioToolResult,
  StudioToolsetOffer,
} from '../../../packages/studio-protocol/src/public'
import type { McpConnectionMetadata } from '../../shared/modules/mcp-tools'
import {
  createClientToolRegistry,
  type ClientToolAuditEntry,
  type ClientToolCaller,
  type ClientToolConnection,
  type ClientToolRegistry,
} from './client-tool-registry'
import { createClientToolsetStore, type ClientToolsetStore } from './client-toolset-store'

// The registry against fake connections and a fake clock: every way a call
// can end (8.1 of the client-tools spec), the names, the reach, and routing.

type FakeConnection = ClientToolConnection & { frames: Array<StudioCallFrame | StudioCancelFrame> }

let store: ClientToolsetStore
let registry: ClientToolRegistry
let started: Map<string, string>
let reach: Map<string, 'own' | 'all'>
let audit: ClientToolAuditEntry[]
let changes: number
let sequence = 0

beforeEach(() => {
  vi.useFakeTimers()
  store = createClientToolsetStore({})
  started = new Map()
  reach = new Map()
  audit = []
  changes = 0
  registry = createClientToolRegistry({
    store,
    servedFamilies: () => ['workspace', 'conversation', 'agent'],
    reservedNames: () => ['backlog-extra'],
    reachOf: (clientId) => reach.get(clientId) ?? 'own',
    startedBy: (conversation) => started.get(`${conversation.workspaceId}/${conversation.agentId}`) ?? null,
    onChange: () => changes++,
    audit: (entry) => audit.push(entry),
  })
})
afterEach(() => {
  registry.close()
  vi.useRealTimers()
})

function connect(
  clientId: string,
  options: {
    instanceId?: string
    owner?: boolean
    shell?: ClientToolConnection['shell']
    kind?: ClientToolConnection['kind']
  } = {},
): FakeConnection {
  const frames: FakeConnection['frames'] = []
  const connection: FakeConnection = {
    connectionId: `conn-${++sequence}`,
    clientId,
    clientName: clientId === 'owner' ? 'Studio desktop' : `App ${clientId}`,
    kind: options.kind ?? (options.owner || clientId === 'owner' ? 'desktop' : 'app'),
    instanceId: options.instanceId ?? `instance-${clientId}-${sequence}-0123456789`,
    owner: options.owner ?? clientId === 'owner',
    shell: options.shell ?? null,
    audited: true,
    frames,
    send: (frame) => frames.push(frame),
  }
  registry.attach(connection)
  return connection
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object' },
  ...extra,
})
const toolset = (
  name: string,
  tools = [tool('spawn_enemy'), tool('screenshot', { mutates: false })],
): StudioToolsetOffer => ({
  name,
  tools,
})

const agent = (agentId = 'agent-1', conversation = true, gatewayConnectionId = `gw-${agentId}`): ClientToolCaller => {
  const metadata: McpConnectionMetadata = { kind: 'studio-agent', workspaceId: 'ws-1', agentId }
  return { gatewayConnectionId, metadata, ...(conversation ? { conversation: { workspaceId: 'ws-1', agentId } } : {}) }
}
const external = (): ClientToolCaller => ({ gatewayConnectionId: 'gw-external', metadata: { kind: 'external-local' } })
const remote = (): ClientToolCaller => ({
  gatewayConnectionId: 'gw-remote',
  metadata: { kind: 'remote-tailnet', deviceId: 'dev-1', deviceName: 'android-phone' },
})

const text = (value: string): StudioToolResult => ({ content: [{ type: 'text', text: value }] })
const code = (result: StudioToolResult) => (result.structuredContent?.error as { code?: string } | undefined)?.code
const lastCall = (connection: FakeConnection) =>
  [...connection.frames].reverse().find((frame): frame is StudioCallFrame => frame.t === 'call')!

async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0)
  return promise
}

test('an app binds a name on its first offer, and nobody else may take it', () => {
  const game = connect('game-app')
  const offered = registry.offer(game.connectionId, toolset('game'))
  assert.deepEqual(offered, {
    ok: true,
    toolset: 'game',
    wireNames: ['game.spawn_enemy', 'game.screenshot'],
    reach: 'own',
  })
  assert.equal(store.binding('game')?.clientId, 'game-app')
  const rival = connect('rival-app')
  const taken = registry.offer(rival.connectionId, toolset('game'))
  assert.equal(taken.ok ? null : taken.code, 'name_taken')
  // The owner is a client too, and takes no app's name.
  const owner = connect('owner', { shell: 'all' })
  const ownerTaken = registry.offer(owner.connectionId, toolset('game'))
  assert.equal(ownerTaken.ok ? null : ownerTaken.code, 'name_taken')
  // A second process of the same app offers it again freely.
  const again = connect('game-app')
  assert.equal(registry.offer(again.connectionId, toolset('game')).ok, true)
  assert.deepEqual(
    audit.map((entry) => [entry.clientId, entry.tool, entry.toolset, entry.tools, entry.ok, entry.code ?? null]),
    [
      ['game-app', 'tools.offer', 'game', 2, true, null],
      ['rival-app', 'tools.offer', 'game', 2, false, 'name_taken'],
      ['owner', 'tools.offer', 'game', 2, false, 'name_taken'],
      ['game-app', 'tools.offer', 'game', 2, true, null],
    ],
  )
})

test('built-in and reserved names are the shell’s, and a name Studio serves is no one’s', () => {
  const app = connect('game-app')
  for (const name of ['browser', 'canvas', 'studio', 'backlog-extra']) {
    const refused = registry.offer(app.connectionId, toolset(name))
    assert.deepEqual([name, refused.ok ? null : refused.code], [name, 'reserved_name'])
  }
  const shell = connect('owner', { shell: 'all' })
  assert.equal(registry.offer(shell.connectionId, toolset('browser')).ok, true)
  assert.equal(registry.offer(shell.connectionId, toolset('backlog')).ok, true)
  const served = registry.offer(shell.connectionId, toolset('workspace'))
  assert.equal(served.ok ? null : served.code, 'reserved_name')
  // A web client may offer the canvas and nothing else of the shell's.
  const web = connect('owner', { shell: ['canvas'], kind: 'web' })
  assert.equal(registry.offer(web.connectionId, toolset('canvas')).ok, true)
  const browser = registry.offer(web.connectionId, toolset('browser'))
  assert.equal(browser.ok ? null : browser.code, 'reserved_name')
  // Built-ins are never bound to a pairing.
  assert.equal(store.binding('browser'), null)
})

test('an app’s tools reach the conversations it started or was opened to, unless its reach is all', () => {
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  const shell = connect('owner', { shell: 'all' })
  registry.offer(shell.connectionId, toolset('browser', [tool('open', { mutates: true })]))
  const names = (caller: ClientToolCaller) => registry.visibleTools(caller).map((entry) => entry.wireName)
  // Built-ins reach every caller, as today.
  assert.deepEqual(names(agent('stranger')), ['browser.open'])
  assert.deepEqual(names(external()), ['browser.open'])
  assert.deepEqual(names(remote()), ['browser.open'])
  started.set('ws-1/started-here', 'game-app')
  assert.deepEqual(names(agent('started-here')).sort(), ['browser.open', 'game.screenshot', 'game.spawn_enemy'])
  // A declared agent id without a proven conversation is not that conversation.
  assert.deepEqual(names(agent('started-here', false)), ['browser.open'])
  assert.deepEqual(registry.grant({ workspaceId: 'ws-1', agentId: 'granted' }, 'game', true), {
    ok: true,
    grants: ['game'],
  })
  assert.equal(names(agent('granted')).length, 3)
  registry.grant({ workspaceId: 'ws-1', agentId: 'granted' }, 'game', false)
  assert.equal(names(agent('granted')).length, 1)
  const notOffered = registry.grant({ workspaceId: 'ws-1', agentId: 'granted' }, 'browser', true)
  assert.equal(notOffered.ok ? null : notOffered.code, 'not_offered')
  reach.set('game-app', 'all')
  assert.equal(names(agent('stranger')).length, 3)
  assert.equal(names(external()).length, 3)
  // Never to a paired device, in this version.
  assert.deepEqual(names(remote()), ['browser.open'])
  // Mutation is the app's word, defaulting to true; a built-in's must be said.
  const mutates = Object.fromEntries(
    registry.visibleTools(agent('stranger')).map((entry) => [entry.wireName, entry.mutates]),
  )
  assert.deepEqual(mutates, { 'browser.open': true, 'game.spawn_enemy': true, 'game.screenshot': false })
})

test('a call is sent to its client and answered with the client’s reply', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  const pending = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: { x: 1 } })
  const frame = lastCall(game)
  assert.deepEqual(
    { ...frame, id: 'id' },
    {
      t: 'call',
      id: 'id',
      toolset: 'game',
      tool: 'spawn_enemy',
      input: { x: 1 },
      context: {
        connection: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' },
        conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
      },
      timeoutMs: 60_000,
    },
  )
  registry.reply(game.connectionId, { t: 'reply', id: frame.id, ok: true, result: text('Spawned #4.') })
  const outcome = await pending
  assert.deepEqual(outcome.result, text('Spawned #4.'))
  assert.deepEqual(outcome.servedBy, {
    clientId: 'game-app',
    clientName: 'App game-app',
    instanceId: game.instanceId,
    kind: 'app',
  })
  // A second reply to the same id is dropped.
  registry.reply(game.connectionId, { t: 'reply', id: frame.id, ok: true, result: text('again') })
  assert.equal(registry.pendingCalls(), 0)
  // A client's own failure reads as every gateway error does.
  const failing = registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} })
  registry.reply(game.connectionId, {
    t: 'reply',
    id: lastCall(game).id,
    ok: false,
    error: { code: 'tool_failed', message: 'The level is not loaded.' },
  })
  const failed = await failing
  assert.equal(failed.result.isError, true)
  assert.equal(
    failed.result.content[0].type === 'text' && failed.result.content[0].text,
    'tool_failed: The level is not loaded.',
  )
  // Device fields go to the shell only.
  const deviceCaller: ClientToolCaller = { ...remote(), metadata: { ...remote().metadata } }
  const shell = connect('owner', { shell: 'all' })
  registry.offer(shell.connectionId, toolset('browser', [tool('status')]))
  void registry.call({ caller: deviceCaller, toolset: 'browser', tool: 'status', args: {} })
  assert.equal(lastCall(shell).context.connection.deviceName, 'android-phone')
})

test('a reply too large for an agent’s line is answered too_large', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  const pending = registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} })
  registry.reply(game.connectionId, {
    t: 'reply',
    id: lastCall(game).id,
    ok: true,
    result: { content: [{ type: 'image', data: 'A'.repeat(1_000_000), mimeType: 'image/png' }] },
  })
  assert.equal(code((await pending).result), 'too_large')
})

test('the deadline answers timeout, and the client is told to stop', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game', [tool('slow', { timeoutMs: 2_000 })]))
  const pending = registry.call({ caller: agent(), toolset: 'game', tool: 'slow', args: {} })
  const id = lastCall(game).id
  assert.equal(lastCall(game).timeoutMs, 2_000)
  await vi.advanceTimersByTimeAsync(2_000 + 4_999)
  assert.equal(registry.pendingCalls(), 1)
  await vi.advanceTimersByTimeAsync(1)
  const outcome = await pending
  assert.equal(code(outcome.result), 'timeout')
  assert.deepEqual(game.frames.at(-1), { t: 'cancel', id, reason: 'timeout' })
  // A late reply is dropped.
  registry.reply(game.connectionId, { t: 'reply', id, ok: true, result: text('late') })
})

test('an interrupted turn, an agent’s own cancel and an agent going away each cancel the call', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  const interrupted = registry.call({ caller: agent('chat'), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const first = lastCall(game).id
  assert.equal(registry.cancelCallsFor({ workspaceId: 'ws-1', agentId: 'chat' }), 1)
  assert.equal(code((await interrupted).result), 'cancelled')
  assert.deepEqual(game.frames.at(-1), { t: 'cancel', id: first, reason: 'interrupted' })

  const controller = new AbortController()
  const aborted = registry.call({
    caller: agent('chat'),
    toolset: 'game',
    tool: 'spawn_enemy',
    args: {},
    signal: controller.signal,
  })
  const second = lastCall(game).id
  controller.abort()
  assert.equal(code((await aborted).result), 'cancelled')
  assert.deepEqual(game.frames.at(-1), { t: 'cancel', id: second, reason: 'interrupted' })

  const gone = registry.call({ caller: agent('chat', true, 'gw-9'), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const third = lastCall(game).id
  registry.gatewayConnectionClosed('gw-9')
  assert.equal(code((await gone).result), 'cancelled')
  assert.deepEqual(game.frames.at(-1), { t: 'cancel', id: third, reason: 'agent_gone' })
})

test('a dropped client that comes back within the grace and offers again is sent its calls again', async () => {
  reach.set('game-app', 'all')
  const instanceId = 'game-process-0123456789'
  const first = connect('game-app', { instanceId })
  registry.offer(first.connectionId, toolset('game'))
  const mutation = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: { x: 1 } })
  const id = lastCall(first).id
  registry.detach(first.connectionId)
  // A call made while it is away waits for it rather than going elsewhere.
  const waiting = registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} })
  await vi.advanceTimersByTimeAsync(15_000)
  const second = connect('game-app', { instanceId })
  assert.equal(second.frames.length, 0)
  registry.offer(second.connectionId, toolset('game'))
  const resent = second.frames.filter((frame): frame is StudioCallFrame => frame.t === 'call')
  assert.equal(resent.length, 2)
  assert.deepEqual([resent[0].id, resent[0].redelivery], [id, true])
  // The waiting call was never sent before, so it is not a redelivery.
  assert.equal(resent[1].redelivery, undefined)
  registry.reply(second.connectionId, { t: 'reply', id, ok: true, result: text('once') })
  registry.reply(second.connectionId, { t: 'reply', id: resent[1].id, ok: true, result: text('picture') })
  assert.deepEqual((await mutation).result, text('once'))
  assert.deepEqual((await waiting).result, text('picture'))
  // The grace was cancelled by the return: nothing expires later.
  await vi.advanceTimersByTimeAsync(30_000)
  assert.equal(registry.visibleTools(agent()).length, 2)
})

test('a process that comes back without a toolset, or without one of its tools, is not waited on to its deadline', async () => {
  reach.set('game-app', 'all')
  const instanceId = 'game-process-0123456789'
  const first = connect('game-app', { instanceId })
  registry.offer(first.connectionId, toolset('game'))
  const sent = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  registry.detach(first.connectionId)
  const waiting = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  // It comes back, and nothing is sent under what it offered before until it offers again.
  const second = connect('game-app', { instanceId })
  const meanwhile = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  assert.equal(second.frames.length, 0)
  // It never offers the toolset again: after a grace, what it may have run is
  // answered so, and what it was never sent finds nobody else.
  await vi.advanceTimersByTimeAsync(20_000)
  assert.equal(code((await sent).result), 'client_disconnected')
  assert.equal(code((await waiting).result), 'client_unavailable')
  assert.equal(code((await meanwhile).result), 'client_unavailable')
  assert.equal(registry.pendingCalls(), 0)

  // Offered again without a tool: a call waiting for that tool is answered at once.
  const third = connect('game-app', { instanceId: 'game-process-abcdefghij' })
  registry.offer(third.connectionId, toolset('game'))
  const read = registry.call({ caller: agent('reader'), toolset: 'game', tool: 'screenshot', args: {} })
  registry.detach(third.connectionId)
  const fourth = connect('game-app', { instanceId: 'game-process-abcdefghij' })
  registry.offer(fourth.connectionId, toolset('game', [tool('spawn_enemy')]))
  assert.equal(code((await settled(read)).result), 'tool_withdrawn')
})

test('a call cancelled while its client is away is cancelled there when it comes back', async () => {
  reach.set('game-app', 'all')
  const instanceId = 'game-process-0123456789'
  const first = connect('game-app', { instanceId })
  registry.offer(first.connectionId, toolset('game'))
  const running = registry.call({ caller: agent('chat'), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const id = lastCall(first).id
  registry.detach(first.connectionId)
  assert.equal(registry.cancelCallsFor({ workspaceId: 'ws-1', agentId: 'chat' }), 1)
  assert.equal(code((await running).result), 'cancelled')
  const second = connect('game-app', { instanceId })
  assert.deepEqual(second.frames, [{ t: 'cancel', id, reason: 'interrupted' }])
})

test('the offer rate limit is a connection’s: a process that reconnects may offer again', () => {
  const instanceId = 'game-process-0123456789'
  let connection = connect('game-app', { instanceId })
  for (let index = 0; index < 20; index++)
    assert.equal(registry.offer(connection.connectionId, toolset('game')).ok, true)
  const refused = registry.offer(connection.connectionId, toolset('game'))
  assert.equal(refused.ok ? null : refused.code, 'busy')
  registry.detach(connection.connectionId)
  connection = connect('game-app', { instanceId })
  assert.equal(registry.offer(connection.connectionId, toolset('game')).ok, true)
})

test('when the grace runs out, a read is routed once more and a mutation is answered client_disconnected', async () => {
  reach.set('game-app', 'all')
  const gone = connect('game-app', { instanceId: 'old-process-0123456789' })
  registry.offer(gone.connectionId, toolset('game'))
  const mutation = registry.call({ caller: agent('a'), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const read = registry.call({ caller: agent('a'), toolset: 'game', tool: 'screenshot', args: {} })
  registry.detach(gone.connectionId)
  // The process restarted: a new instance, which never saw those calls.
  const restarted = connect('game-app', { instanceId: 'new-process-0123456789' })
  registry.offer(restarted.connectionId, toolset('game'))
  assert.equal(restarted.frames.length, 0)
  await vi.advanceTimersByTimeAsync(20_000)
  const failed = await mutation
  assert.equal(code(failed.result), 'client_disconnected')
  assert.match(
    failed.result.content[0].type === 'text' ? failed.result.content[0].text : '',
    /may or may not have finished/,
  )
  const rerouted = lastCall(restarted)
  assert.equal(rerouted.tool, 'screenshot')
  assert.equal(rerouted.redelivery, undefined)
  registry.reply(restarted.connectionId, { t: 'reply', id: rerouted.id, ok: true, result: text('shot') })
  // The conversation's affinity moved with it, and the agent is told.
  const answered = await read
  assert.match(
    answered.result.content[0].type === 'text' ? answered.result.content[0].text : '',
    /is now in App game-app/,
  )
})

test('a read whose client is gone with nobody else to take it answers client_unavailable', async () => {
  reach.set('game-app', 'all')
  const gone = connect('game-app')
  registry.offer(gone.connectionId, toolset('game'))
  const read = registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} })
  registry.detach(gone.connectionId)
  await vi.advanceTimersByTimeAsync(20_000)
  const answered = await read
  assert.equal(code(answered.result), 'client_unavailable')
  assert.match(answered.result.content[0].type === 'text' ? answered.result.content[0].text : '', /is not running/)
  // The tool stays describable for a catalog that listed it.
  assert.equal(registry.definitionOf('game', 'screenshot')?.wireName, 'game.screenshot')
  assert.equal(registry.isKnownToolset('game'), true)
  assert.equal(registry.visibleTools(agent()).length, 0)
  // A built-in names the fix.
  const builtIn = await settled(registry.call({ caller: agent(), toolset: 'browser', tool: 'open', args: {} }))
  assert.match(
    builtIn.result.content[0].type === 'text' ? builtIn.result.content[0].text : '',
    /Open Studio on a desktop/,
  )
})

test('a withdrawal lets a running call finish and answers later ones tool_withdrawn', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  const running = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const id = lastCall(game).id
  assert.deepEqual(registry.withdraw(game.connectionId, 'game'), { ok: true, withdrawn: true })
  const later = await settled(registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} }))
  assert.equal(code(later.result), 'tool_withdrawn')
  registry.reply(game.connectionId, { t: 'reply', id, ok: true, result: text('done anyway') })
  assert.deepEqual((await running).result, text('done anyway'))
  const unknown = registry.withdraw(game.connectionId, 'game')
  assert.equal(unknown.ok ? null : unknown.code, 'not_offered')
  // A newer offer that drops a tool: that tool answers tool_withdrawn, the rest work.
  registry.offer(game.connectionId, toolset('game', [tool('spawn_enemy')]))
  const dropped = await settled(registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} }))
  assert.equal(code(dropped.result), 'tool_withdrawn')
})

test('a reconnect on a new connection while the old one is open moves the calls over', async () => {
  reach.set('game-app', 'all')
  const instanceId = 'same-process-0123456789'
  const old = connect('game-app', { instanceId })
  registry.offer(old.connectionId, toolset('game'))
  const pending = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  const id = lastCall(old).id
  const fresh = connect('game-app', { instanceId })
  assert.deepEqual(old.frames.at(-1), { t: 'cancel', id, reason: 'client_replaced' })
  registry.offer(fresh.connectionId, toolset('game'))
  assert.equal(lastCall(fresh).redelivery, true)
  // The replaced connection's answer is not the instance's any more.
  registry.reply(old.connectionId, { t: 'reply', id, ok: true, result: text('stale') })
  registry.reply(fresh.connectionId, { t: 'reply', id, ok: true, result: text('fresh') })
  assert.deepEqual((await pending).result, text('fresh'))
})

test('routing: affinity, then the client in focus, then the one showing the workspace, then the starter, then kind', async () => {
  const desktop = connect('owner', { shell: 'all', kind: 'desktop', instanceId: 'desktop-a-0123456789' })
  const other = connect('owner', { shell: 'all', kind: 'desktop', instanceId: 'desktop-b-0123456789' })
  const headless = connect('owner', { shell: 'all', kind: 'headless', instanceId: 'headless-0123456789' })
  for (const connection of [headless, other, desktop])
    registry.offer(connection.connectionId, toolset('browser', [tool('status')]))
  const target = (connection: FakeConnection) => connection.frames.filter((frame) => frame.t === 'call').length
  const counts = () => [target(desktop), target(other), target(headless)]
  // By kind, then newest offer: a desktop before the headless client.
  void registry.call({ caller: agent('k1'), toolset: 'browser', tool: 'status', args: {} })
  assert.deepEqual(counts(), [1, 0, 0])
  // Showing the workspace beats kind; in focus beats showing.
  registry.focus(headless.connectionId, { focused: false, workspaceIds: ['ws-1'] })
  void registry.call({ caller: agent('k2'), toolset: 'browser', tool: 'status', args: {} })
  assert.deepEqual(counts(), [1, 0, 1])
  registry.focus(other.connectionId, { focused: true, workspaceIds: ['ws-1'] })
  void registry.call({ caller: agent('k3'), toolset: 'browser', tool: 'status', args: {} })
  assert.deepEqual(counts(), [1, 1, 1])
  // Affinity: a conversation's calls do not hop once it has started.
  void registry.call({ caller: agent('k1'), toolset: 'browser', tool: 'status', args: {} })
  void registry.call({ caller: agent('k2'), toolset: 'browser', tool: 'status', args: {} })
  assert.deepEqual(counts(), [2, 1, 2])
  // The instance that started a conversation, once focus says nothing.
  registry.focus(other.connectionId, { focused: false, workspaceIds: [] })
  registry.focus(headless.connectionId, { focused: false, workspaceIds: [] })
  registry.noteStarted(headless.connectionId, { workspaceId: 'ws-1', agentId: 'k4' })
  void registry.call({ caller: agent('k4'), toolset: 'browser', tool: 'status', args: {} })
  assert.deepEqual(counts(), [2, 1, 3])
})

test('limits: calls in flight per agent are bounded, and so are an app’s calls per second', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  for (let index = 0; index < 8; index++)
    void registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} })
  const ninth = await settled(registry.call({ caller: agent(), toolset: 'game', tool: 'screenshot', args: {} }))
  assert.equal(code(ninth.result), 'busy')
  assert.equal(typeof ninth.result.structuredContent?.retryAfterMs, 'number')
  // Another agent is not held to the first one's calls, until the app's own bound.
  for (let index = 0; index < 8; index++)
    void registry.call({ caller: agent(`other-${index}`), toolset: 'game', tool: 'screenshot', args: {} })
  const seventeenth = await settled(
    registry.call({ caller: agent('one-more'), toolset: 'game', tool: 'screenshot', args: {} }),
  )
  assert.equal(code(seventeenth.result), 'busy')
})

test('offers are rate limited and bounded per connection', () => {
  const game = connect('game-app')
  for (let index = 0; index < 8; index++)
    assert.equal(registry.offer(game.connectionId, toolset(`set-${index}`)).ok, true)
  const ninth = registry.offer(game.connectionId, toolset('set-extra'))
  assert.equal(ninth.ok ? null : ninth.code, 'too_large')
  for (let index = 0; index < 11; index++) registry.offer(game.connectionId, toolset('set-0'))
  const limited = registry.offer(game.connectionId, toolset('set-0'))
  assert.equal(limited.ok ? null : limited.code, 'busy')
  assert.ok(!limited.ok && (limited.retryAfterMs ?? 0) > 0)
})

test('the shell’s reserved toolsets do not count against a connection’s bound, and its own toolsets still do', () => {
  // The WSL front door offers a server the shell's six and the Windows side's
  // own families: more reserved names than the bound holds.
  const shell = connect('owner', { shell: 'all' })
  const reserved = ['browser', 'canvas', 'editor', 'tour', 'terminal', 'backlog', 'schedule', 'cli', 'module']
  for (const name of reserved) assert.equal(registry.offer(shell.connectionId, toolset(name)).ok, true, name)
  for (let index = 0; index < 8; index++)
    assert.equal(registry.offer(shell.connectionId, toolset(`set-${index}`)).ok, true)
  const ninth = registry.offer(shell.connectionId, toolset('set-extra'))
  assert.equal(ninth.ok ? null : ninth.code, 'too_large')
})

test('revoking an app releases its names and ends what it was running', async () => {
  reach.set('game-app', 'all')
  const game = connect('game-app')
  registry.offer(game.connectionId, toolset('game'))
  registry.grant({ workspaceId: 'ws-1', agentId: 'chat' }, 'game', true)
  const pending = registry.call({ caller: agent(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  assert.deepEqual(registry.forgetClient('game-app'), ['game'])
  assert.equal(code((await pending).result), 'client_unavailable')
  assert.equal(store.binding('game'), null)
  assert.deepEqual(registry.grantsOf({ workspaceId: 'ws-1', agentId: 'chat' }), [])
  // Another app may take the name now, and inherits nothing.
  const next = connect('next-app')
  assert.equal(registry.offer(next.connectionId, toolset('game')).ok, true)
  assert.deepEqual(registry.grantsOf({ workspaceId: 'ws-1', agentId: 'chat' }), [])
})

test('the catalog shows an app its own toolsets and the built-ins, and an owner all of them', () => {
  const game = connect('game-app')
  registry.offer(game.connectionId, { ...toolset('game'), title: 'Acme Game' })
  const other = connect('other-app')
  registry.offer(other.connectionId, toolset('notes', [tool('add')]))
  const shell = connect('owner', { shell: 'all' })
  registry.offer(shell.connectionId, toolset('browser', [tool('status')]))
  assert.deepEqual(
    registry.catalog({ clientId: 'game-app', owner: false }).map((listing) => listing.name),
    ['browser', 'game'],
  )
  const all = registry.catalog({ clientId: 'owner', owner: true })
  assert.deepEqual(
    all.map((listing) => listing.name),
    ['browser', 'game', 'notes'],
  )
  const gameListing = all.find((listing) => listing.name === 'game')!
  assert.equal(gameListing.title, 'Acme Game')
  assert.deepEqual(gameListing.offeredBy, [
    { clientName: 'App game-app', kind: 'app', instanceId: game.instanceId, connected: true },
  ])
  registry.detach(game.connectionId)
  assert.equal(
    registry.catalog({ clientId: 'owner', owner: true }).find((l) => l.name === 'game')!.offeredBy[0].connected,
    false,
  )
  assert.ok(changes > 0)
})

test('whenOffered waits for the shell’s toolsets, and gives up after its wait', async () => {
  const waiting = registry.whenOffered(['browser', 'canvas'], 5_000)
  const shell = connect('owner', { shell: 'all' })
  registry.offer(shell.connectionId, toolset('browser', [tool('status')]))
  registry.offer(shell.connectionId, toolset('canvas', [tool('list')]))
  await vi.advanceTimersByTimeAsync(50)
  assert.equal(await waiting, true)
  const never = registry.whenOffered(['editor'], 5_000)
  await vi.advanceTimersByTimeAsync(5_100)
  assert.equal(await never, false)
})

test('an app’s first offer of a name is told once, and its toolsets read back with how each stands', () => {
  const told: string[] = []
  const local = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => [],
    onFirstOffer: (entry) => told.push(`${entry.clientName}:${entry.toolset}:${entry.tools}`),
  })
  const first: ClientToolConnection = {
    connectionId: 'c-1',
    clientId: 'game-app',
    clientName: 'Acme Game',
    kind: 'app',
    instanceId: 'game-instance-0123456789',
    owner: false,
    shell: null,
    audited: true,
    send: () => undefined,
  }
  local.attach(first)
  local.offer('c-1', toolset('game'))
  local.offer('c-1', toolset('game'))
  assert.deepEqual(told, ['Acme Game:game:2'])
  assert.deepEqual(local.toolsetsOf('game-app'), [{ name: 'game', title: 'Acme Game', tools: 2, state: 'offered' }])
  local.detach('c-1')
  assert.equal(local.toolsetsOf('game-app')[0].state, 'reconnecting')
  local.close()
})
