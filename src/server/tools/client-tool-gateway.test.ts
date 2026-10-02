import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type {
  StudioCallFrame,
  StudioCancelFrame,
  StudioToolsetOffer,
} from '../../../packages/studio-protocol/src/public'
import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMcpSocketServer, type McpSocketServer } from '../../main/automation/mcp-socket-server'
import { bindGatewayConversation, createClientToolGateway } from './client-tool-gateway'
import { createClientToolRegistry, type ClientToolConnection, type ClientToolRegistry } from './client-tool-registry'
import { createClientToolsetStore } from './client-toolset-store'

// Client tools through the real gateway socket: what an agent lists, what it
// is told, and what a call answers when its client is gone.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const STUDIO_TOOL: McpToolRegistration = {
  name: 'workspace.list',
  description: 'Studio’s own tool.',
  inputSchema: { type: 'object' },
  handler: async () => ({ content: [{ type: 'text', text: '[]' }] }),
}

type Harness = {
  registry: ClientToolRegistry
  server: McpSocketServer
  socketPath: string
  contexts: McpConnectionContext[]
  client(
    clientId: string,
    shell?: ClientToolConnection['shell'],
  ): ClientToolConnection & { frames: Array<StudioCallFrame | StudioCancelFrame> }
}

async function harness(options: { expect?: string[]; reach?: 'own' | 'all' } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'client-tool-gateway-'))
  const registry = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => ['workspace'],
    reachOf: () => options.reach ?? 'own',
  })
  const gateway = createClientToolGateway({
    registry,
    ...(options.expect ? { expectShellToolsets: options.expect, bootWaitMs: 300 } : {}),
  })
  const contexts: McpConnectionContext[] = []
  const socketPath = join(directory, 'gateway.sock')
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'test',
    serverVersion: '0.0.0-test',
    resolveTools: (context) => {
      if (context && !contexts.includes(context)) contexts.push(context)
      return [...gateway.builtIns(context), STUDIO_TOOL, ...gateway.apps(context)]
    },
    clientTools: {
      ready: () => gateway.ready(),
      fallback: (context, name) => gateway.fallback(context, name),
      track: (context, notify) => {
        if (!contexts.includes(context)) contexts.push(context)
        return gateway.track(context, notify)
      },
    },
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    registry.close()
    rmSync(directory, { recursive: true, force: true })
  })
  let sequence = 0
  return {
    registry,
    server,
    socketPath,
    contexts,
    client(clientId, shell = null) {
      const frames: Array<StudioCallFrame | StudioCancelFrame> = []
      const connection = {
        connectionId: `client-${++sequence}`,
        clientId,
        clientName: clientId === 'owner' ? 'Studio desktop' : 'Acme Game',
        kind: clientId === 'owner' ? ('desktop' as const) : ('app' as const),
        instanceId: `instance-${clientId}-${sequence}-0123456789`,
        owner: clientId === 'owner',
        shell,
        audited: true,
        frames,
        send: (frame: StudioCallFrame | StudioCancelFrame) => frames.push(frame),
      }
      registry.attach(connection)
      return connection
    },
  }
}

type Agent = {
  socket: Socket
  messages: Array<Record<string, unknown>>
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  send(message: Record<string, unknown>): void
  next(match: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  count(match: (message: Record<string, unknown>) => boolean): number
}

async function agent(socketPath: string, declared: Record<string, unknown> = {}): Promise<Agent> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  cleanups.push(() => void socket.destroy())
  const messages: Array<Record<string, unknown>> = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      messages.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      buffer = buffer.slice(newline + 1)
    }
  })
  let id = 0
  const next = async (match: (message: Record<string, unknown>) => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = messages.findIndex(match)
      if (index !== -1) return messages.splice(index, 1)[0]
      if (Date.now() > deadline) throw new Error(`No matching message in ${JSON.stringify(messages).slice(0, 400)}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const send = (message: Record<string, unknown>) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  send({ method: 'sprintengine.studio/connect', params: declared })
  return {
    socket,
    messages,
    send,
    next,
    count: (match) => messages.filter(match).length,
    async request(method, params = {}) {
      const requestId = ++id
      send({ id: requestId, method, params })
      return next((message) => message.id === requestId)
    },
  }
}

const names = async (client: Agent) =>
  (((await client.request('tools/list')).result as { tools: Array<{ name: string }> }).tools ?? []).map(
    (tool) => tool.name,
  )
const listChanged = (message: Record<string, unknown>) => message.method === 'notifications/tools/list_changed'
const toolset = (name: string, tools: string[], extra: Partial<StudioToolsetOffer> = {}): StudioToolsetOffer => ({
  name,
  tools: tools.map((tool) => ({ name: tool, description: `${tool} does a thing.`, inputSchema: { type: 'object' } })),
  ...extra,
})

test('the shell’s toolsets come first, apps’ last, and an app’s description says where it is from', async () => {
  const { registry, socketPath, client } = await harness({ reach: 'all' })
  const shell = client('owner', 'all')
  registry.offer(shell.connectionId, toolset('canvas', ['list']))
  registry.offer(shell.connectionId, toolset('browser', ['status', 'open']))
  const game = client('game-app')
  registry.offer(
    game.connectionId,
    toolset('game', ['spawn_enemy'], { title: 'Acme Game', description: 'Controls the level.' }),
  )
  const caller = await agent(socketPath)
  assert.deepEqual(await names(caller), [
    'browser.status',
    'browser.open',
    'canvas.list',
    'workspace.list',
    'game.spawn_enemy',
  ])
  const listed = (await caller.request('tools/list')).result as { tools: Array<{ name: string; description: string }> }
  assert.equal(
    listed.tools.find((tool) => tool.name === 'game.spawn_enemy')?.description,
    '[From Acme Game, an app connected to Studio.] Controls the level. spawn_enemy does a thing.',
  )
  // A built-in's description is passed through unchanged.
  assert.equal(listed.tools.find((tool) => tool.name === 'browser.status')?.description, 'status does a thing.')
})

test('a catalog only grows: a gone client’s tool stays listed and answers client_unavailable', async () => {
  const { registry, socketPath, client } = await harness({ reach: 'all' })
  const game = client('game-app')
  registry.offer(game.connectionId, toolset('game', ['spawn_enemy']))
  const caller = await agent(socketPath)
  assert.deepEqual(await names(caller), ['workspace.list', 'game.spawn_enemy'])
  registry.withdraw(game.connectionId, 'game')
  assert.deepEqual(await names(caller), ['workspace.list', 'game.spawn_enemy'])
  const withdrawn = await caller.request('tools/call', { name: 'game.spawn_enemy', arguments: {} })
  assert.match(JSON.stringify(withdrawn.result), /tool_withdrawn/)
  registry.detach(game.connectionId)
  // A new connection that never listed it does not see it.
  const fresh = await agent(socketPath)
  assert.deepEqual(await names(fresh), ['workspace.list'])
  // But a call to it, as a bridge that reconnected would make, is answered as a client that is not there.
  const gone = await fresh.request('tools/call', { name: 'game.spawn_enemy', arguments: {} })
  assert.match(JSON.stringify(gone.result), /tool_withdrawn|client_unavailable/)
  // A name no client could answer for is still an unknown tool.
  const unknown = await fresh.request('tools/call', { name: 'nothing.here', arguments: {} })
  assert.ok(unknown.error)
})

test('a burst of offers is one notification, and only to a connection that can see them', async () => {
  const { registry, socketPath, client, contexts } = await harness({ reach: 'own' })
  const shell = client('owner', 'all')
  const insider = await agent(socketPath, { agentId: 'chat-1', workspaceId: 'ws-1' })
  const outsider = await agent(socketPath, { agentId: 'chat-2', workspaceId: 'ws-1' })
  await names(insider)
  await names(outsider)
  // The insider's connection is proven to be the conversation the app is opened to.
  const insiderContext = contexts.find((context) => context.metadata.agentId === 'chat-1')!
  bindGatewayConversation(insiderContext, { workspaceId: 'ws-1', agentId: 'chat-1' })
  const game = client('game-app')
  registry.offer(game.connectionId, toolset('game', ['spawn_enemy']))
  registry.grant({ workspaceId: 'ws-1', agentId: 'chat-1' }, 'game', true)
  registry.offer(game.connectionId, toolset('game', ['spawn_enemy', 'screenshot']))
  registry.offer(shell.connectionId, toolset('browser', ['status']))
  await insider.next(listChanged)
  // Coalesced: the rest of the burst lands in the next window, not now.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(insider.count(listChanged), 0)
  assert.deepEqual(await names(insider), ['browser.status', 'workspace.list', 'game.spawn_enemy', 'game.screenshot'])
  // The outsider is told of the browser, never of the game.
  await outsider.next(listChanged)
  assert.deepEqual(await names(outsider), ['browser.status', 'workspace.list'])
})

test('an agent’s cancel reaches the client, and progress reaches an agent that asked for it', async () => {
  const { registry, socketPath, client } = await harness({ reach: 'all' })
  const game = client('game-app')
  registry.offer(game.connectionId, toolset('game', ['slow']))
  const caller = await agent(socketPath)
  caller.send({
    id: 41,
    method: 'tools/call',
    params: { name: 'game.slow', arguments: {}, _meta: { progressToken: 'p-1' } },
  })
  for (let tries = 0; !game.frames.some((frame) => frame.t === 'call') && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const call = game.frames.find((frame): frame is StudioCallFrame => frame.t === 'call')!
  registry.progress(game.connectionId, { t: 'progress', id: call.id, message: 'Halfway.' })
  const progress = await caller.next((message) => message.method === 'notifications/progress')
  assert.deepEqual(progress.params, { progressToken: 'p-1', progress: 1, message: 'Halfway.' })
  caller.send({ method: 'notifications/cancelled', params: { requestId: 41, reason: 'The person pressed stop.' } })
  const answered = await caller.next((message) => message.id === 41)
  assert.match(JSON.stringify(answered.result), /cancelled/)
  assert.deepEqual(game.frames.at(-1), { t: 'cancel', id: call.id, reason: 'interrupted' })
})

test('an agent that goes away cancels what it was waiting on', async () => {
  const { registry, socketPath, client } = await harness({ reach: 'all' })
  const game = client('game-app')
  registry.offer(game.connectionId, toolset('game', ['slow']))
  const caller = await agent(socketPath)
  caller.send({ id: 1, method: 'tools/call', params: { name: 'game.slow', arguments: {} } })
  for (let tries = 0; !game.frames.some((frame) => frame.t === 'call') && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  caller.socket.destroy()
  for (let tries = 0; !game.frames.some((frame) => frame.t === 'cancel') && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(game.frames.find((frame) => frame.t === 'cancel')?.reason, 'agent_gone')
})

test('a desktop’s server lists the shell’s toolsets from the first tools/list, waiting for them at start', async () => {
  const { registry, socketPath, client } = await harness({ expect: ['browser', 'canvas'] })
  const caller = await agent(socketPath)
  const listing = names(caller)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const shell = client('owner', 'all')
  registry.offer(shell.connectionId, toolset('browser', ['status']))
  registry.offer(shell.connectionId, toolset('canvas', ['list']))
  assert.deepEqual(await listing, ['browser.status', 'canvas.list', 'workspace.list'])
})
