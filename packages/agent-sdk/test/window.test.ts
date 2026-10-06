import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../../../src/server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../../../src/server/rpc/studio-rpc-server'
import {
  createFakeAuthenticator,
  createFakeBackend,
  type FakeBackend,
} from '../../../src/server/rpc/studio-rpc.test-helper'
import type { StudioChatBackend } from '../../../src/server/rpc/studio-rpc-types'
import type { ConversationSessionFrame } from '../../../src/shared/conversation-runtime'
import { createMemoryChannel, type MemoryChannelEnd } from '../../../tests/memory-channel'
import { connect, type StudioClient, type StudioTransportFactory } from '../src/index'

// The client over a connection that brings its own credential, as a Studio
// window's does: a port per connection and a ticket good for its one hello.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Window = {
  server: StudioRpcServer
  backend: FakeBackend
  /** Every frame the client sent, decoded. */
  sent: Array<Record<string, unknown>>
  /** The tickets handed out, one per connection. */
  tickets: string[]
  /** Drop the open connection, as a reload of the server would. */
  drop(): void
  /** From now on, connections reach a different Studio. */
  replace(environmentId: string): void
  commandListeners: Set<(catalog: unknown) => void>
  transport: StudioTransportFactory
}

function window(options: { follow?: FakeBackend['follow'] } = {}): Window {
  const backend = createFakeBackend()
  if (options.follow) backend.follow = options.follow
  const commandListeners = new Set<(catalog: unknown) => void>()
  const chat = {
    onCommandsChanged: (listener: (catalog: unknown) => void) => {
      commandListeners.add(listener)
      return () => commandListeners.delete(listener)
    },
    releaseFileSearches: () => undefined,
  } as unknown as StudioChatBackend
  const make = (environmentId: string) => {
    const made = createStudioRpcServer({
      dataDir: '/nonexistent/sdk-window',
      version: '0.0.0-test',
      environmentId,
      backend,
      chat: () => chat,
      authenticator: createFakeAuthenticator(),
    })
    cleanups.push(() => made.stop(1))
    return made
  }
  let server = make('env-test')
  const sent: Array<Record<string, unknown>> = []
  const tickets: string[] = []
  let open: MemoryChannelEnd | null = null
  const transport: StudioTransportFactory = async () => {
    const [mainEnd, clientEnd] = createMemoryChannel()
    const ticket = mintStudioTicket()
    tickets.push(ticket)
    server.attach(framePortStream(mainEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
    open = clientEnd
    const messages: Array<(frame: string) => void> = []
    clientEnd.onFrame((frame) => messages.forEach((listener) => listener(frame)))
    return {
      credential: { token: ticket },
      send: (frame) => {
        sent.push(JSON.parse(frame) as Record<string, unknown>)
        clientEnd.post(frame)
      },
      close: () => clientEnd.close(),
      onMessage: (listener) => void messages.push(listener),
      onClose: (listener) => clientEnd.onClose(() => listener()),
    }
  }
  return {
    get server() {
      return server
    },
    backend,
    sent,
    tickets,
    drop: () => open?.close(),
    replace: (environmentId) => {
      server = make(environmentId)
    },
    commandListeners,
    transport,
  }
}

async function connected(target: Window): Promise<StudioClient> {
  const client = await connect({
    transport: target.transport,
    client: { name: 'Studio window' },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  })
  cleanups.push(() => client.close())
  return client
}

const until = async (check: () => boolean) => {
  for (let tries = 0; !check() && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(check())
}

test('a transport’s own credential says each hello, a fresh one for every connection, and no auth is needed', async () => {
  const target = window()
  const client = await connected(target)
  assert.equal(client.grant.owner, true)
  assert.equal(client.grant.name, 'Studio window')
  target.drop()
  await until(() => target.tickets.length === 2 && client.state === 'open')
  const hellos = target.sent.filter((frame) => frame.t === 'hello')
  assert.deepEqual(
    hellos.map((frame) => (frame.auth as { token: string }).token),
    target.tickets,
  )
  assert.equal(new Set(target.tickets).size, 2, 'a ticket is never said twice')
  await assert.rejects(
    connect({
      transport: async () => {
        const transport = await target.transport()
        return { ...transport, credential: undefined }
      },
      client: { name: 'nobody' },
      reconnect: false,
    }),
    /No credential/,
  )
})

test('a push stream hears each payload, and is subscribed again on the next connection', async () => {
  const target = window()
  const client = await connected(target)
  const heard: unknown[] = []
  const stop = client.subscribe('conversation.commands', {}, { onPayload: (payload) => heard.push(payload) })
  await until(() => target.commandListeners.size === 1)
  for (const listener of target.commandListeners) listener({ cli: 'codex', commands: [] })
  await until(() => heard.length === 1)
  target.drop()
  await until(() => target.tickets.length === 2 && target.commandListeners.size === 1)
  for (const listener of target.commandListeners) listener({ cli: 'codex', commands: [{ name: 'review' }] })
  await until(() => heard.length === 2)
  assert.deepEqual(heard, [
    { cli: 'codex', commands: [] },
    { cli: 'codex', commands: [{ name: 'review' }] },
  ])
  stop()
  await until(() => target.commandListeners.size === 0)
})

test('a ref names its folder to a Studio that serves folders', async () => {
  const target = window()
  const client = await connected(target)
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/app/.worktrees/run-1' }
  const frames: string[] = []
  const stop = client.conversations.follow(ref, undefined, (frame) => frames.push(frame.type))
  await until(() => frames.includes('synchronized'))
  stop()
  const sub = target.sent.find((frame) => frame.t === 'sub')
  assert.deepEqual((sub?.params as { key: unknown }).key, ref)
})

test('a consumer that retries by itself hears a stream Studio could not start, instead of a silent retry', async () => {
  let follows = 0
  const failing: FakeBackend['follow'] = (_key, _cursor, listener: (frame: ConversationSessionFrame) => void) => {
    follows++
    queueMicrotask(() => listener({ type: 'error', message: 'Transcript is busy' }))
    return { dispose: () => undefined, ready: Promise.resolve() }
  }
  const target = window({ follow: failing })
  const client = await connected(target)
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const frames: Array<{ type: string; message?: string }> = []
  client.conversations.follow(ref, { resubscribe: false }, (frame) => frames.push(frame))
  await until(() => frames.length === 1)
  assert.deepEqual(frames, [{ type: 'error', message: 'Transcript is busy' }])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(follows, 1, 'and nothing subscribes again behind its back')
})

test('a reconnect that reaches a different Studio is refused: no cursor resumed, no command sent again', async () => {
  const target = window()
  const client = await connected(target)
  assert.equal(client.welcome.environment.id, 'env-test')
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const frames: Array<{ type: string; message?: string }> = []
  client.conversations.follow(ref, undefined, (frame) => frames.push(frame))
  await until(() => frames.some((frame) => frame.type === 'synchronized'))
  const subscribed = () => target.sent.filter((frame) => frame.t === 'sub').length
  const before = subscribed()
  target.replace('env-elsewhere')
  target.drop()
  const pending = client.request('server.info', {})
  await assert.rejects(client.closed, (error: { code?: string }) => error.code === 'environment_changed')
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'environment_changed')
  assert.equal(subscribed(), before, 'no stream resumed its cursor over there')
  const infos = target.sent.filter((frame) => frame.t === 'req' && frame.method === 'server.info')
  assert.equal(infos.length, 1, 'and the request in flight was not sent again')
  assert.equal(frames.at(-1)?.type, 'error')

  // A client bound to a Studio up front refuses any other from the start.
  await assert.rejects(
    connect({ transport: target.transport, client: { name: 'w' }, environmentId: 'env-test', reconnect: false }),
    (error: { code?: string }) => error.code === 'environment_changed',
  )
})

test('offline, a client parks with what it was asked kept, and the network coming back wakes it', async () => {
  const events = new EventTarget()
  const navigator = { onLine: true }
  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
  try {
    const target = window()
    const client = await connected(target)
    navigator.onLine = false
    target.drop()
    const stateOf = () => client.state as string
    for (let tries = 0; stateOf() !== 'parked' && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(stateOf(), 'parked')
    assert.equal(target.tickets.length, 1, 'and it does not try while offline')
    // Kept, not refused: it goes out once the network is back.
    const asked = client.request('workspaces.list', {} as never).then(
      () => 'answered',
      (error: { code?: string }) => error.code,
    )
    navigator.onLine = true
    events.dispatchEvent(new Event('online'))
    for (let tries = 0; stateOf() !== 'open' && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(stateOf(), 'open')
    assert.equal(target.tickets.length, 2)
    // This test's chat surface has no workspaces: refused, but by Studio, so it went out.
    assert.notEqual(await asked, 'offline')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a client of a Studio on this machine keeps reconnecting while the device is offline', async () => {
  vi.stubGlobal('navigator', { onLine: false })
  try {
    const target = window()
    const client = await connect({
      transport: target.transport,
      client: { name: 'Studio window' },
      reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      parkWhenOffline: false,
    })
    cleanups.push(() => client.close())
    target.drop()
    await until(() => target.tickets.length === 2 && client.state === 'open')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a stream’s cursor is what its consumer has read, never what is still waiting to be read', async () => {
  const target = window()
  const client = await connected(target)
  const stream = client.conversation({ workspaceId: 'ws-1', agentId: 'agent-1' }).events()
  for (let next = await stream.next(); next.value?.type !== 'synchronized'; next = await stream.next());
  const fenced = stream.cursor
  assert.ok(fenced)
  // A second follower on the same connection says when both events have
  // reached this client, so the stream has them waiting, unread.
  const arrived: string[] = []
  let watchingLive = false
  const watching = client.conversations.follow({ workspaceId: 'ws-1', agentId: 'agent-1' }, undefined, (frame) => {
    if (frame.type === 'synchronized') watchingLive = true
    if (frame.type === 'event') arrived.push(String(frame.event.payload?.text))
  })
  await until(() => watchingLive)
  target.backend.emit('agent-1', 'user_message', { text: 'one' })
  target.backend.emit('agent-1', 'user_message', { text: 'two' })
  await until(() => arrived.length === 2)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(arrived, ['one', 'two'])
  // Received, not yet read: the cursor has not moved.
  assert.deepEqual(stream.cursor, fenced)
  const first = await stream.next()
  assert.equal(first.value?.type === 'event' && first.value.event.payload?.text, 'one')
  assert.equal(stream.cursor?.afterSeq, (first.value?.type === 'event' && first.value.event.seq) || -1)
  const second = await stream.next()
  assert.equal(stream.cursor?.afterSeq, (second.value?.type === 'event' && second.value.event.seq) || -1)
  stream.close()
  watching()
})
