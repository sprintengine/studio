import assert from 'node:assert/strict'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { ConversationBackend } from '../core/conversation-backend'
import { PassThrough } from 'node:stream'

import {
  connectRemoteConversationBackend,
  lineFrames,
  REMOTE_BACKEND_MEMBERS,
  serveConversationBackend,
} from './backend-wire'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function summary(
  sessionId: string,
  status: ConversationSessionSummary['status'] = 'ready',
): ConversationSessionSummary {
  return {
    sessionId,
    workspaceId: 'ws-1',
    agentId: `agent-${sessionId}`,
    providerId: 'mock',
    modelId: 'model',
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A backend that records calls and lets the test publish events. */
function fakeBackend() {
  const sessions = new Map<string, ConversationSessionSummary>()
  const listeners = new Set<(event: ConversationEvent) => void>()
  const calls: Array<{ member: string; args: unknown[] }> = []
  const record =
    (member: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ member, args })
      return answer(...args)
    }
  const backend = {
    onEvent(listener: (event: ConversationEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listSessions(input: { workspaceId?: string; agentId?: string } = {}) {
      return {
        ok: true as const,
        sessions: [...sessions.values()].filter(
          (session) =>
            (!input.workspaceId || session.workspaceId === input.workspaceId) &&
            (!input.agentId || session.agentId === input.agentId),
        ),
      }
    },
    startSession: record('startSession', () => {
      const started = summary('s1', 'starting')
      sessions.set('s1', started)
      return { ok: true, session: started }
    }),
    listThreads: record('listThreads', () => ({ ok: true, threads: [] })),
    searchThreads: record('searchThreads', (_input, options) => ({
      ok: true,
      hits: [{ agentId: 'a', seq: 1, snippet: typeof options === 'object' ? 'had options' : 'no options' }],
    })),
    endTerminalHandoff: (...args: unknown[]) => void calls.push({ member: 'endTerminalHandoff', args }),
    renameThread: record('renameThread', () => {
      throw new Error('Conversation was not found.')
    }),
  } as unknown as ConversationBackend
  const publish = (event: ConversationEvent, next?: ConversationSessionSummary) => {
    if (next) sessions.set(next.sessionId, next)
    for (const listener of listeners) listener(event)
  }
  return { backend, calls, publish, sessions }
}

async function pair(): Promise<{ server: Socket; client: Socket }> {
  const path = join(tmpdir(), `se-wire-${process.pid}-${Math.random().toString(16).slice(2, 8)}.sock`)
  let accepted: (socket: Socket) => void = () => undefined
  const serverSocket = new Promise<Socket>((resolve) => (accepted = resolve))
  const listener: Server = createServer((socket) => accepted(socket))
  await new Promise<void>((resolve) => listener.listen(path, resolve))
  cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())))
  const client = connect(path)
  await new Promise((resolve) => client.once('connect', resolve))
  const server = await serverSocket
  cleanups.push(() => {
    client.destroy()
    server.destroy()
  })
  return { server, client }
}

function event(type: ConversationEvent['type'], sessionId = 's1'): ConversationEvent {
  return {
    id: `e-${type}`,
    sessionId,
    workspaceId: 'ws-1',
    agentId: `agent-${sessionId}`,
    providerId: 'mock',
    modelId: 'model',
    type,
    createdAt: 2,
  }
}

test('every async backend member the router forwards is carried, and only those', () => {
  assert.ok(!(REMOTE_BACKEND_MEMBERS as readonly string[]).includes('listSessions'), 'answered from the mirror')
  assert.ok(!(REMOTE_BACKEND_MEMBERS as readonly string[]).includes('onEvent'))
  assert.ok((REMOTE_BACKEND_MEMBERS as readonly string[]).includes('sendTurn'))
})

test('a call crosses with its arguments, and its session lands in the mirror before the answer returns', async () => {
  const fake = fakeBackend()
  const { server, client } = await pair()
  serveConversationBackend(fake.backend, server)
  const remote = connectRemoteConversationBackend(client)
  const started = await remote.startSession({
    workspaceRoot: '/home/dev/repo',
    workspaceId: 'ws-1',
    agentId: 'agent-s1',
    providerId: 'mock',
    modelId: 'model',
  })
  assert.ok(started.ok)
  assert.deepEqual(fake.calls[0], {
    member: 'startSession',
    args: [
      {
        workspaceRoot: '/home/dev/repo',
        workspaceId: 'ws-1',
        agentId: 'agent-s1',
        providerId: 'mock',
        modelId: 'model',
      },
    ],
  })
  const listed = remote.listSessions({ workspaceId: 'ws-1' })
  assert.ok(listed.ok)
  assert.deepEqual(
    listed.sessions.map((session) => session.sessionId),
    ['s1'],
  )
})

test("an event arrives with its session's new summary already mirrored, and a snapshot drops a session that left", async () => {
  const fake = fakeBackend()
  const { server, client } = await pair()
  serveConversationBackend(fake.backend, server)
  const remote = connectRemoteConversationBackend(client)
  const seen: Array<{ type: string; status: string | undefined }> = []
  remote.onEvent((next) => {
    const listed = remote.listSessions({ agentId: next.agentId })
    seen.push({ type: next.type, status: listed.ok ? listed.sessions[0]?.status : undefined })
  })
  fake.publish(event('session_ready'), summary('s1', 'ready'))
  await waitFor(() => seen.length === 1)
  assert.deepEqual(seen, [{ type: 'session_ready', status: 'ready' }])

  fake.sessions.clear()
  await waitFor(() => {
    const listed = remote.listSessions()
    return listed.ok && listed.sessions.length === 0
  })
  fake.sessions.set('s2', summary('s2'))
  await remote.refresh()
  const listed = remote.listSessions()
  assert.ok(listed.ok && listed.sessions[0]?.sessionId === 's2')
})

test("search's callbacks stay on this side: the hits come back whole and go to onBatch once", async () => {
  const fake = fakeBackend()
  const { server, client } = await pair()
  serveConversationBackend(fake.backend, server)
  const remote = connectRemoteConversationBackend(client)
  const batches: unknown[] = []
  const result = await remote.searchThreads(
    { workspaceRoot: '/home/dev/repo', workspaceId: 'ws-1', query: 'x' },
    { onBatch: (hits) => batches.push(hits) },
  )
  assert.ok(result.ok)
  assert.equal(result.hits[0]?.snippet, 'no options', 'no function crossed')
  assert.equal(batches.length, 1)
})

test('a failure is the server’s own words, and a closed wire answers every call unavailable', async () => {
  const fake = fakeBackend()
  const { server, client } = await pair()
  serveConversationBackend(fake.backend, server)
  const remote = connectRemoteConversationBackend(client)
  await assert.rejects(
    remote.renameThread({ workspaceRoot: '/r', workspaceId: 'ws-1', agentId: 'a', title: 't' }),
    /Conversation was not found/u,
  )
  remote.endTerminalHandoff({ sessionId: 's1' })
  await waitFor(() => fake.calls.some((entry) => entry.member === 'endTerminalHandoff'))
  const closed = new Promise<string>((resolve) => remote.onClose(resolve))
  server.destroy()
  await closed
  assert.equal(remote.isOpen(), false)
  await assert.rejects(remote.listThreads({ workspaceRoot: '/r', workspaceId: 'ws-1' }), /closed|ended/u)
})

test('a call a server never answers fails after its bound, while a turn is left to run', async () => {
  const { server, client } = await pair()
  // A server that reads every call and answers none, as a hung one does.
  server.on('data', () => undefined)
  const remote = connectRemoteConversationBackend(client, { memberTimeoutMs: 100 })
  const turn = remote.sendTurn({ sessionId: 's1', message: 'hi' } as never)
  let turnSettled = false
  void turn.then(
    () => (turnSettled = true),
    () => (turnSettled = true),
  )
  await assert.rejects(remote.listThreads({ workspaceRoot: '/r', workspaceId: 'ws-1' }), /not answered within 100 ms/u)
  assert.equal(turnSettled, false)
  client.destroy()
  await turn.catch(() => undefined)
})

async function waitFor(condition: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a large frame in many small chunks reads whole, with a character split across them and a frame behind it', () => {
  const stream = new PassThrough()
  const frames: unknown[] = []
  lineFrames(stream).onFrame((frame) => frames.push(frame))
  const large = 'é'.repeat(300_000)
  const bytes = Buffer.from(`{"n":0}\n${JSON.stringify({ text: large })}\n{"n":1}\n{"n":`, 'utf8')
  // An odd size splits the two-byte characters between chunks.
  for (let start = 0; start < bytes.length; start += 16_383) stream.write(bytes.subarray(start, start + 16_383))
  stream.write('2}\n')
  assert.deepEqual(frames, [{ n: 0 }, { text: large }, { n: 1 }, { n: 2 }])
})
