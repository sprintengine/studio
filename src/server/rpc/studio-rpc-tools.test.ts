import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach, test } from 'vitest'

import type { StudioCallFrame, StudioToolsetListing } from '../../../packages/studio-protocol/src/public'
import { createClientToolRegistry, type ClientToolRegistry } from '../tools/client-tool-registry'
import { createClientToolsetStore } from '../tools/client-toolset-store'
import {
  OWNER_TOKEN,
  connectLineClient,
  createFakeAuthenticator,
  hello,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'

// The `tools.*` methods and the call frames on a real socket: who may offer
// what, a call there and back, the frames a client may not send, and the
// catalog push.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const toolset = (name: string) => ({
  name,
  title: 'Acme Game',
  tools: [{ name: 'spawn_enemy', description: 'Spawn one.', inputSchema: { type: 'object' } }],
})

async function setup(): Promise<{
  registry: ClientToolRegistry
  offers: string[]
  path: string
  auth: ReturnType<typeof createFakeAuthenticator>
  audit: Awaited<ReturnType<typeof startTestServer>>['audit']
  server: Awaited<ReturnType<typeof startTestServer>>['server']
  open(token: string, client?: Record<string, unknown>): Promise<LineClient>
}> {
  const offers: string[] = []
  const registry = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => ['workspace'],
    reachOf: () => 'all',
    audit: (entry) => offers.push(`${entry.clientId}:${entry.toolset}`),
  })
  const auth = createFakeAuthenticator()
  const started = await startTestServer({ tools: registry, auth })
  cleanups.push(() => started.dispose())
  cleanups.push(() => registry.close())
  return {
    registry,
    offers,
    path: started.path,
    auth,
    audit: started.audit,
    server: started.server,
    async open(
      token,
      client = { name: 'test-app', instanceId: `inst-${Math.random().toString(36).slice(2)}-0123456789` },
    ) {
      const line = await connectLineClient(started.path)
      cleanups.push(() => line.close())
      line.send(hello({ token }, { client }))
      const welcome = await line.next((frame) => frame.t === 'welcome')
      assert.equal(welcome.t, 'welcome')
      return line
    },
  }
}

const request = async (client: LineClient, id: string, method: string, params: unknown) => {
  client.send({ t: 'req', id, method, params })
  return client.next((frame) => frame.t === 'res' && frame.id === id)
}

const caller = {
  gatewayConnectionId: 'gw-1',
  metadata: { kind: 'studio-agent' as const, agentId: 'a1', workspaceId: 'ws-1' },
}

test('the welcome advertises client tools only where a registry serves them', async () => {
  const { path } = await setup()
  const served = await connectLineClient(path)
  cleanups.push(() => served.close())
  served.send(hello({ token: OWNER_TOKEN }))
  const advertised = await served.next((frame) => frame.t === 'welcome')
  assert.equal(advertised.t === 'welcome' && advertised.capabilities.includes('client-tools'), true)
  const without = await startTestServer()
  cleanups.push(() => without.dispose())
  const plain = await connectLineClient(without.path)
  cleanups.push(() => plain.close())
  plain.send(hello({ token: OWNER_TOKEN }))
  const welcome = await plain.next((frame) => frame.t === 'welcome')
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('client-tools'), false)
  const offered = await request(plain, 'r1', 'tools.offer', { toolset: toolset('game') })
  assert.equal(offered.t === 'res' && !offered.ok && offered.error.code, 'unavailable')
})

test('offering needs tools:offer; the shell’s names and another app’s are refused', async () => {
  const { open, auth, audit } = await setup()
  const reader = await open(pairFakeClient(auth, 'reader-app', ['conversation:read']))
  const refused = await request(reader, 'r1', 'tools.offer', { toolset: toolset('game') })
  assert.equal(refused.t === 'res' && !refused.ok && refused.error.code, 'scope_required')
  const game = await open(pairFakeClient(auth, 'game-app', ['conversation:read', 'tools:offer']))
  const browser = await request(game, 'r2', 'tools.offer', { toolset: toolset('browser') })
  assert.equal(browser.t === 'res' && !browser.ok && browser.error.code, 'reserved_name')
  const offered = await request(game, 'r3', 'tools.offer', { toolset: toolset('game') })
  assert.deepEqual(offered.t === 'res' && offered.ok && offered.result, {
    toolset: 'game',
    wireNames: ['game.spawn_enemy'],
    reach: 'all',
  })
  const rival = await open(pairFakeClient(auth, 'rival-app', ['tools:offer']))
  const taken = await request(rival, 'r4', 'tools.offer', { toolset: toolset('game') })
  assert.equal(taken.t === 'res' && !taken.ok && taken.error.code, 'name_taken')
  // A bad offer is refused by its shape before the registry sees it.
  const bad = await request(game, 'r5', 'tools.offer', { toolset: { name: 'Bad_Name', tools: [] } })
  assert.equal(bad.t === 'res' && !bad.ok && bad.error.code, 'invalid_params')
  // The grant is the owner's to give.
  const grant = await request(game, 'r6', 'tools.grant', {
    key: { workspaceId: 'ws-1', agentId: 'agent-1' },
    toolset: 'game',
    granted: true,
    commandId: 'g1',
  })
  assert.equal(grant.t === 'res' && !grant.ok && grant.error.code, 'owner_required')
  const owner = await open(OWNER_TOKEN, {
    name: 'Studio desktop',
    kind: 'desktop',
    instanceId: 'desktop-0123456789abcdef',
  })
  const granted = await request(owner, 'r7', 'tools.grant', {
    key: { workspaceId: 'ws-1', agentId: 'agent-1' },
    toolset: 'game',
    granted: true,
    commandId: 'g2',
  })
  assert.deepEqual(granted.t === 'res' && granted.ok && granted.result, { grants: ['game'] })
  // An owner that says it is a desktop is the shell: it may offer the browser.
  const shellOffer = await request(owner, 'r8', 'tools.offer', { toolset: toolset('browser') })
  assert.equal(shellOffer.t === 'res' && shellOffer.ok, true)
  // Offers, withdrawals and grants are audited with the toolset's name and size, never input.
  assert.deepEqual(
    audit.filter((entry) => entry.tool === 'tools.grant').map((entry) => [entry.toolset, entry.ok]),
    [
      ['game', false],
      ['game', true],
    ],
  )
})

test('a call reaches its client and the reply reaches the agent', async () => {
  const { open, auth, registry } = await setup()
  const game = await open(pairFakeClient(auth, 'game-app', ['tools:offer']))
  await request(game, 'r1', 'tools.offer', { toolset: toolset('game') })
  const pending = registry.call({ caller, toolset: 'game', tool: 'spawn_enemy', args: { x: 2 } })
  const call = (await game.next((frame) => frame.t === 'call')) as StudioCallFrame
  assert.deepEqual(call.input, { x: 2 })
  game.send({ t: 'progress', id: call.id, progress: 1, total: 2 })
  game.send({ t: 'reply', id: call.id, ok: true, result: { content: [{ type: 'text', text: 'Spawned.' }] } })
  assert.deepEqual((await pending).result, { content: [{ type: 'text', text: 'Spawned.' }] })
  // A reply Studio cannot read is dropped, not answered, and the connection stays.
  game.send({ t: 'reply', id: call.id, ok: true, result: { content: 'nope' } })
  const alive = await request(game, 'r2', 'server.ping', {})
  assert.equal(alive.t === 'res' && alive.ok, true)
})

test('a client that was never sent a call is closed for answering one', async () => {
  const { open, auth } = await setup()
  const reader = await open(pairFakeClient(auth, 'reader-app', ['conversation:read']))
  reader.send({ t: 'reply', id: 'x', ok: true, result: { content: [] } })
  const bye = await reader.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'invalid_frame')
})

test('revoking an app drops its offers at once', async () => {
  const { open, auth, registry } = await setup()
  const game = await open(pairFakeClient(auth, 'game-app', ['tools:offer']))
  await request(game, 'r1', 'tools.offer', { toolset: toolset('game') })
  assert.equal(registry.visibleTools(caller).length, 1)
  auth.revoke('game-app')
  await game.next((frame) => frame.t === 'bye')
  assert.equal(registry.visibleTools(caller).length, 0)
  assert.equal(registry.isKnownToolset('game'), false)
})

test('the catalog is a push of the whole listing after each change', async () => {
  const { open, auth } = await setup()
  const owner = await open(OWNER_TOKEN)
  owner.send({ t: 'sub', id: 's1', topic: 'tools.catalog' })
  const game = await open(pairFakeClient(auth, 'game-app', ['tools:offer', 'conversation:read']))
  await request(game, 'r1', 'tools.offer', { toolset: toolset('game') })
  const push = await owner.next((frame) => frame.t === 'push' && frame.sub === 's1')
  const listings = (push as { payload: { toolsets: StudioToolsetListing[] } }).payload.toolsets
  assert.deepEqual(
    listings.map((listing) => [listing.name, listing.title, listing.offeredBy.length]),
    [['game', 'Acme Game', 1]],
  )
  const asked = await request(game, 'r2', 'tools.catalog', {})
  assert.deepEqual(
    asked.t === 'res' && asked.ok && (asked.result as { toolsets: StudioToolsetListing[] }).toolsets.map((l) => l.name),
    ['game'],
  )
})

test('the desktop’s own port is the shell whatever its hello says, and its offers are not audited', async () => {
  const { server, registry, offers } = await setup()
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const shellAuth = createFakeAuthenticator()
  const serverSide = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk)
      callback()
    },
  })
  toServer.on('data', (chunk: Buffer) => serverSide.push(chunk))
  server.attach(serverSide, {
    authenticator: shellAuth,
    ownWindow: false,
    shell: true,
  })
  const frames: Array<Record<string, unknown>> = []
  let buffer = ''
  toClient.setEncoding('utf8')
  toClient.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      buffer = buffer.slice(newline + 1)
    }
  })
  const until = async (match: (frame: Record<string, unknown>) => boolean) => {
    for (let tries = 0; tries < 200; tries++) {
      const found = frames.find(match)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`No matching frame in ${JSON.stringify(frames)}`)
  }
  toServer.write(`${JSON.stringify(hello({ token: OWNER_TOKEN }, { client: { name: 'Studio desktop' } }))}\n`)
  await until((frame) => frame.t === 'welcome')
  toServer.write(
    `${JSON.stringify({ t: 'req', id: 'o1', method: 'tools.offer', params: { toolset: toolset('browser') } })}\n`,
  )
  const answer = await until((frame) => frame.t === 'res' && frame.id === 'o1')
  assert.equal(answer.ok, true)
  assert.deepEqual(
    registry.visibleTools(caller).map((definition) => [definition.wireName, definition.builtIn]),
    [['browser.spawn_enemy', true]],
  )
  assert.deepEqual(offers, [])
  toServer.end()
})
