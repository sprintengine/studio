import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

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
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/sdk-window',
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend,
    chat: () => chat,
    authenticator: createFakeAuthenticator(),
  })
  cleanups.push(() => server.stop(1))
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
  return { server, backend, sent, tickets, drop: () => open?.close(), commandListeners, transport }
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
