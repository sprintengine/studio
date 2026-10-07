import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createStudioRpcServer, type StudioRpcServer } from '../../../src/server/rpc/studio-rpc-server'
import {
  OWNER_TOKEN,
  createFakeAuthenticator,
  createFakeBackend,
  pairFakeClient,
  type FakeAuthenticator,
} from '../../../src/server/rpc/studio-rpc.test-helper'
import { createClientToolRegistry, type ClientToolRegistry } from '../../../src/server/tools/client-tool-registry'
import { createClientToolsetStore } from '../../../src/server/tools/client-toolset-store'
import { StudioError, StudioToolError, connect, toolResult, type StudioClient, type ToolCall } from '../src/index'
import type { StudioCallFrame } from '../src/protocol'
import { createClientTools } from '../src/tools'
import { socketTransport } from '../src/node'

// `client.tools` against the in-process router: an offer, a call there and
// back, a dropped connection in the middle of a call, a process that
// restarted, and a cancel.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Studio = { dataDir: string; server: StudioRpcServer; registry: ClientToolRegistry; auth: FakeAuthenticator }

async function studio(graceMs = 20_000): Promise<Studio> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-sdk-tools-'))
  const auth = createFakeAuthenticator()
  const registry = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => ['workspace'],
    reachOf: () => 'all',
    graceMs,
  })
  const server = createStudioRpcServer({
    dataDir,
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend: createFakeBackend(),
    authenticator: auth,
    tools: registry,
    resyncRetryAfterMs: () => 20,
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    registry.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { dataDir, server, registry, auth }
}

async function client(target: Studio, token = OWNER_TOKEN): Promise<StudioClient> {
  const connected = await connect({
    transport: socketTransport({ dataDir: target.dataDir }),
    client: { name: 'Acme Game' },
    auth: { token },
    reconnect: { initialDelayMs: 10, maxDelayMs: 30 },
    heartbeat: false,
  })
  cleanups.push(() => connected.close())
  return connected
}

const caller = (agentId = 'agent-1') => ({
  gatewayConnectionId: `gw-${agentId}`,
  metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId, agentName: 'Scout', cliId: 'claude-code' },
  conversation: { workspaceId: 'ws-1', agentId },
})

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}.`)
}

test('an offer is checked here first, then made; a call reaches its handler and the answer the agent', async () => {
  const target = await studio()
  const app = await client(target, pairFakeClient(target.auth, 'game-app', ['tools:offer', 'conversation:read']))
  assert.equal(app.supports('client-tools'), true)
  await assert.rejects(
    app.tools.offer({
      name: 'game',
      tools: [{ name: 'Bad Name', description: 'x', inputSchema: { type: 'object' }, handler: () => 'x' }],
    }),
    (error: StudioError) => error.code === 'invalid_params',
  )
  const calls: ToolCall[] = []
  const game = await app.tools.offer({
    name: 'game',
    title: 'Acme Game',
    tools: [
      {
        name: 'spawn_enemy',
        description: 'Spawn an enemy.',
        inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
        handler: (input, call) => {
          calls.push(call)
          call.progress({ message: 'Spawning.' })
          return toolResult.text(`Spawned at ${String(input.x)}.`, { id: 4 })
        },
      },
      {
        name: 'fail',
        description: 'Always fails.',
        inputSchema: { type: 'object' },
        handler: () => {
          throw new StudioToolError('no_level', 'No level is loaded.')
        },
      },
      {
        name: 'crash',
        description: 'Throws.',
        inputSchema: { type: 'object' },
        handler: () => {
          throw new Error('boom')
        },
      },
    ],
  })
  assert.deepEqual(
    [game.name, game.state, game.wireNames],
    ['game', 'offered', ['game.spawn_enemy', 'game.fail', 'game.crash']],
  )
  const progress: string[] = []
  const answer = await target.registry.call({
    caller: caller(),
    toolset: 'game',
    tool: 'spawn_enemy',
    args: { x: 3 },
    onProgress: (update) => progress.push(update.message ?? ''),
  })
  assert.deepEqual(answer.result, { content: [{ type: 'text', text: 'Spawned at 3.' }], structuredContent: { id: 4 } })
  assert.deepEqual(progress, ['Spawning.'])
  assert.deepEqual(calls[0].conversation, { workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.deepEqual(calls[0].agent, { name: 'Scout', cli: 'claude-code' })
  assert.equal(calls[0].redelivered, false)
  const failed = await target.registry.call({ caller: caller(), toolset: 'game', tool: 'fail', args: {} })
  assert.deepEqual(failed.result, toolResult.error('no_level', 'No level is loaded.'))
  const crashed = await target.registry.call({ caller: caller(), toolset: 'game', tool: 'crash', args: {} })
  assert.equal(crashed.result.content[0].type === 'text' && crashed.result.content[0].text, 'tool_failed: boom')
  assert.deepEqual(
    (await app.tools.catalog()).map((listing) => listing.name),
    ['game'],
  )
  await game.withdraw()
  assert.equal(game.state, 'withdrawn')
  assert.equal(target.registry.visibleTools(caller()).length, 0)
})

test('an answer too large for an agent fails in the app', async () => {
  const target = await studio()
  const app = await client(target)
  await app.tools.offer({
    name: 'game',
    // An owner's tools reach what its offer says; these tests' agents started nowhere.
    reach: 'all',
    tools: [
      {
        name: 'screenshot',
        description: 'A huge picture.',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: () => toolResult.image(new Uint8Array(800 * 1024), 'image/png'),
      },
    ],
  })
  const answer = await target.registry.call({ caller: caller(), toolset: 'game', tool: 'screenshot', args: {} })
  assert.equal(answer.result.content[0].type === 'text' && answer.result.content[0].text.startsWith('too_large'), true)
})

test('an answer that is not a tool result fails in the app, not at the call’s deadline', async () => {
  const target = await studio()
  const app = await client(target)
  await app.tools.offer({
    name: 'game',
    reach: 'all',
    tools: [
      {
        name: 'count',
        description: 'Answers a number.',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: () => 42 as never,
      },
      {
        name: 'label',
        description: 'Answers a part with a number for text.',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: () => ({ content: [{ type: 'text', text: 7 }] }) as never,
      },
    ],
  })
  for (const tool of ['count', 'label']) {
    const answer = await target.registry.call({ caller: caller(), toolset: 'game', tool, args: {} })
    const first = answer.result.content[0]
    assert.equal(first.type === 'text' && first.text.startsWith('invalid_result'), true, tool)
    assert.equal(answer.result.isError, true)
  }
})

test('a call cut off by a dropped connection is sent again, and its handler runs once', async () => {
  const target = await studio()
  const app = await client(target)
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let redelivered = false
  await app.tools.offer({
    name: 'game',
    // An owner's tools reach what its offer says; these tests' agents started nowhere.
    reach: 'all',
    tools: [
      {
        name: 'spawn_enemy',
        description: 'Spawn one.',
        inputSchema: { type: 'object' },
        handler: async (_input, call) => {
          runs++
          redelivered ||= call.redelivered
          await gate
          return 'Spawned once.'
        },
      },
    ],
  })
  const pending = target.registry.call({ caller: caller(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  await until(() => runs === 1, 'the handler to start')
  // The connection drops mid-call; the client comes back and offers again.
  for (const connection of target.server.connections()) connection.bye('internal_error', 'Dropped for the test.', 5)
  await until(() => app.state === 'reconnecting' || app.state === 'open', 'the drop')
  await until(() => app.state === 'open' && target.server.connections().length === 1, 'the reconnect')
  release()
  const answer = await pending
  assert.deepEqual(answer.result, { content: [{ type: 'text', text: 'Spawned once.' }] })
  assert.equal(runs, 1)
  assert.equal(redelivered, false, 'the handler that ran was the first delivery; the redelivery joined it')
})

test('a call answered while the connection was down is answered again from memory', async () => {
  const target = await studio()
  const app = await client(target)
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await app.tools.offer({
    name: 'game',
    // An owner's tools reach what its offer says; these tests' agents started nowhere.
    reach: 'all',
    tools: [
      {
        name: 'spawn_enemy',
        description: 'Spawn one.',
        inputSchema: { type: 'object' },
        handler: async () => {
          runs++
          await gate
          return 'From memory.'
        },
      },
    ],
  })
  const pending = target.registry.call({ caller: caller(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  await until(() => runs === 1, 'the handler to start')
  // Down long enough for the handler to finish while nobody can hear it.
  for (const connection of target.server.connections()) connection.bye('internal_error', 'Dropped for the test.', 150)
  await until(() => app.state === 'reconnecting', 'the drop')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const answer = await pending
  assert.deepEqual(answer.result, { content: [{ type: 'text', text: 'From memory.' }] })
  assert.equal(runs, 1)
})

test('a process that restarted is never handed the mutation its predecessor was running', async () => {
  const target = await studio(150)
  const first = await client(target)
  const offer = (connected: StudioClient, onRun: () => void) =>
    connected.tools.offer({
      name: 'game',
      reach: 'all',
      tools: [
        {
          name: 'spawn_enemy',
          description: 'Spawn one.',
          inputSchema: { type: 'object' },
          handler: () => {
            onRun()
            return new Promise<string>(() => undefined)
          },
        },
      ],
    })
  let firstRuns = 0
  await offer(first, () => firstRuns++)
  const pending = target.registry.call({ caller: caller(), toolset: 'game', tool: 'spawn_enemy', args: {} })
  await until(() => firstRuns === 1, 'the first process to start it')
  first.close()
  // A new process: a new instance id, and no memory of the call.
  const second = await client(target)
  let secondRuns = 0
  await offer(second, () => secondRuns++)
  const answer = await pending
  assert.equal(
    answer.result.content[0].type === 'text' && answer.result.content[0].text.startsWith('client_disconnected'),
    true,
  )
  assert.equal(secondRuns, 0)
})

test('a cancel aborts the handler’s signal', async () => {
  const target = await studio()
  const app = await client(target)
  let aborted: unknown = null
  let started = false
  await app.tools.offer({
    name: 'game',
    // An owner's tools reach what its offer says; these tests' agents started nowhere.
    reach: 'all',
    tools: [
      {
        name: 'wait',
        description: 'Waits until cancelled.',
        inputSchema: { type: 'object' },
        handler: (_input, call) =>
          new Promise<string>((resolve) => {
            started = true
            call.signal.addEventListener('abort', () => {
              aborted = call.signal.reason
              resolve('stopped')
            })
          }),
      },
    ],
  })
  const pending = target.registry.call({ caller: caller('chat-9'), toolset: 'game', tool: 'wait', args: {} })
  await until(() => started, 'the handler to start')
  target.registry.cancelCallsFor({ workspaceId: 'ws-1', agentId: 'chat-9' })
  const answer = await pending
  assert.equal(answer.result.content[0].type === 'text' && answer.result.content[0].text, 'cancelled: Cancelled.')
  await until(() => aborted !== null, 'the abort')
  assert.equal((aborted as StudioError).code, 'cancelled')
})

test('offering needs a Studio that takes tools', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-sdk-tools-'))
  const server = createStudioRpcServer({
    dataDir,
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend: createFakeBackend(),
    authenticator: createFakeAuthenticator(),
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  const app = await connect({
    transport: socketTransport({ dataDir }),
    client: { name: 'old' },
    auth: { token: OWNER_TOKEN },
    heartbeat: false,
  })
  cleanups.push(() => app.close())
  await assert.rejects(
    app.tools.offer({
      name: 'game',
      tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object' }, handler: () => 'x' }],
    }),
    (error: StudioError) => error.code === 'unsupported',
  )
})

test('a call still running is never forgotten, however many finish after it', async () => {
  const sent: Array<Record<string, unknown>> = []
  const tools = createClientTools({
    request: async () => ({ wireNames: ['game.wait', 'game.quick'] }),
    send: (frame) => {
      sent.push(frame)
      return true
    },
    supports: () => true,
    isOpen: () => true,
  })
  let waits = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await tools.api.offer({
    name: 'game',
    tools: [
      {
        name: 'wait',
        description: 'Waits.',
        inputSchema: { type: 'object' },
        handler: async () => {
          waits++
          await gate
          return 'waited'
        },
      },
      { name: 'quick', description: 'Quick.', inputSchema: { type: 'object' }, handler: () => 'quick' },
    ],
  })
  const frame = (id: string, tool: string, redelivery = false): StudioCallFrame => ({
    t: 'call',
    id,
    toolset: 'game',
    tool,
    input: {},
    context: { connection: { kind: 'studio-agent' } },
    timeoutMs: 60_000,
    ...(redelivery ? { redelivery: true as const } : {}),
  })
  tools.handleCall(frame('slow', 'wait'))
  for (let index = 0; index < 2100; index++) tools.handleCall(frame(`quick-${index}`, 'quick'))
  await until(() => sent.length === 2100, 'the quick calls')
  // Redelivered after all of those: it joins the handler, which runs once.
  tools.handleCall(frame('slow', 'wait', true))
  release()
  await until(() => sent.some((reply) => reply.id === 'slow'), 'the slow reply')
  assert.equal(waits, 1)
})

test('a call Studio cancelled is not answered when its handler finishes later', async () => {
  const sent: Array<Record<string, unknown>> = []
  const tools = createClientTools({
    request: async () => ({ wireNames: ['game.wait'] }),
    send: (frame) => {
      sent.push(frame)
      return true
    },
    supports: () => true,
    isOpen: () => true,
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let finished = false
  await tools.api.offer({
    name: 'game',
    tools: [
      {
        name: 'wait',
        description: 'Waits, and ignores its signal.',
        inputSchema: { type: 'object' },
        handler: async () => {
          await gate
          finished = true
          return 'late'
        },
      },
    ],
  })
  tools.handleCall({
    t: 'call',
    id: 'gone',
    toolset: 'game',
    tool: 'wait',
    input: {},
    context: { connection: { kind: 'studio-agent' } },
    timeoutMs: 60_000,
  })
  tools.handleCancel({ t: 'cancel', id: 'gone', reason: 'toolset withdrawn' } as never)
  release()
  await until(() => finished, 'the handler to finish')
  await new Promise((resolve) => setTimeout(resolve, 10))
  // After a reconnect Studio would read a reply to it as a frame for a call it
  // never made, and end the connection for good.
  assert.equal(
    sent.some((frame) => frame.t === 'reply' && frame.id === 'gone'),
    false,
  )
})
