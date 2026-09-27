import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { ConversationEvent, ConversationSessionFrame } from '../../../shared/conversation-runtime'
import { ConversationRuntime } from '../../conversation-runtime'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetConversationStream } from './tailnet-conversation-stream'
import { createWebSocketFrameDecoder, encodeMaskedTextFrame } from './websocket-frames'

class Socket extends Duplex {
  frames: Buffer[] = []
  delayMs = 0
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.frames.push(chunk)
    if (this.delayMs) setTimeout(done, this.delayMs)
    else done()
  }
  receive(frame: unknown): void {
    this.push(encodeMaskedTextFrame(JSON.stringify(frame)))
  }
  output(): unknown[] {
    const decoder = createWebSocketFrameDecoder(256 * 1024, 'client')
    return this.frames.flatMap((bytes) => {
      const read = decoder.push(bytes)
      return read.kind === 'frames'
        ? read.frames
            .filter((frame) => frame.kind === 'text')
            .map((frame) => JSON.parse((frame as { text: string }).text) as unknown)
        : []
    })
  }
}

const key = { workspaceRoot: '/workspace', workspaceId: 'w', agentId: 'a' }
function host(): ConversationGatewayHost {
  return {
    list: async () => [],
    resolveKey: (workspaceId, agentId) => (workspaceId === 'w' && agentId === 'a' ? key : null),
    // A stand-in for transport tests only. What a subscriber is sent on join
    // is the session API's contract, exercised through the real one below.
    subscribe: (_key, _cursor, listener) => {
      const ready = Promise.resolve().then(() => {
        listener({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null }, generation: 'g' })
        listener({ type: 'synchronized', seq: 0, generation: 'g' })
      })
      return { dispose: () => {}, ready }
    },
    loadEarlier: async () => ({ ok: true, page: { events: [], hasMore: false, beforeCursor: null } }),
    getToolDetail: async () => ({ ok: false, code: 'not_found', message: 'Missing.' }),
    getTurnDiff: async () => ({ ok: false, message: 'Missing.' }),
    command: async () => ({ ok: true }),
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('oversized control frames are refused and ping replies respect socket backpressure', async () => {
  const oversized = encodeMaskedTextFrame('x'.repeat(126))
  oversized[0] = 0x89
  const decoder = createWebSocketFrameDecoder(256 * 1024)
  assert.deepEqual(decoder.push(oversized), {
    kind: 'error',
    code: 1002,
    reason: 'Control frame exceeds the 125-byte limit.',
  })
  const socket = new Socket()
  Object.defineProperty(socket, 'writableLength', { get: () => 2 * 1024 * 1024 })
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  const ping = encodeMaskedTextFrame('ping')
  ping[0] = 0x89
  socket.push(ping)
  await tick()
  assert.equal(stream.isClosed(), true)
  const decoded = createWebSocketFrameDecoder(256 * 1024, 'client').push(Buffer.concat(socket.frames))
  assert.ok(decoded.kind === 'frames' && decoded.frames.some((frame) => frame.kind === 'close' && frame.code === 4409))
  socket.destroy()
})

test('slow readers and concurrent read floods close with a resync boundary', async () => {
  for (const mode of ['reader', 'requests']) {
    const socket = new Socket()
    const gateway = host()
    let listener!: (frame: ConversationSessionFrame) => void
    let disposed = 0
    gateway.subscribe = (_key, _cursor, receive) => {
      listener = receive
      return {
        ready: Promise.resolve(),
        dispose: () => {
          disposed++
        },
      }
    }
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes: ['conversation:read'],
      host: gateway,
      onClosed: () => {},
      audit: () => {},
    })
    socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
    await tick()
    if (mode === 'reader') {
      socket.delayMs = 1
      for (let seq = 0; seq < 100; seq++) listener({ type: 'synchronized', seq })
    } else {
      gateway.list = () => new Promise(() => {})
      for (let index = 0; index < 100; index++) socket.receive({ type: 'list', requestId: `list-${index}` })
      await tick()
    }
    assert.equal(stream.isClosed(), true, mode)
    assert.equal(disposed, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const decoder = createWebSocketFrameDecoder(256 * 1024, 'client')
    const decoded = decoder.push(Buffer.concat(socket.frames))
    assert.ok(
      decoded.kind === 'frames' && decoded.frames.some((frame) => frame.kind === 'close' && frame.code === 4409),
    )
    socket.destroy()
  }
})

test('replacing or closing a subscription suppresses stale replay and redacts outbound data', async () => {
  const socket = new Socket()
  const gateway = host()
  const listeners: Array<(frame: ConversationSessionFrame) => void> = []
  let disposed = 0
  gateway.subscribe = (_key, _cursor, receive) => {
    listeners.push(receive)
    return {
      ready: Promise.resolve(),
      dispose: () => {
        disposed++
      },
    }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  listeners[0]({ type: 'synchronized', seq: 1 })
  listeners[1]({
    type: 'event',
    event: {
      id: 'e',
      seq: 2,
      sessionId: 's',
      workspaceId: 'w',
      agentId: 'a',
      providerId: 'p',
      modelId: 'm',
      type: 'tool_started',
      createdAt: 1,
      payload: { input: { path: `${homedir()}/project/file`, apiKey: 'test-secret' } },
    },
  })
  await tick()
  assert.equal(socket.output().length, 1)
  const output = JSON.stringify(socket.output())
  assert.equal(output.includes(homedir()), false)
  assert.equal(output.includes('test-secret'), false)
  assert.ok(output.includes('[home]/project/file'))
  stream.close(1000, 'device_revoked')
  listeners[1]({ type: 'synchronized', seq: 3 })
  assert.equal(socket.output().length, 1)
  assert.equal(disposed, 2)
})

test('heartbeat closes a peer that never returns a pong and stops its timer', () => {
  vi.useFakeTimers()
  try {
    const socket = new Socket()
    let closes = 0
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes: ['conversation:read'],
      host: host(),
      onClosed: () => {
        closes++
      },
      audit: () => {},
    })
    vi.advanceTimersByTime(50_000)
    assert.equal(stream.isClosed(), false)
    vi.advanceTimersByTime(25_000)
    assert.equal(stream.isClosed(), true)
    vi.advanceTimersByTime(100_000)
    assert.equal(closes, 1)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})

test('conversation socket refuses a device without read grant', () => {
  const socket = new Socket()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: [],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  assert.equal(stream.isClosed(), true)
  assert.deepEqual(socket.output()[0], {
    type: 'error',
    code: 'conversation_scope_required',
    message: 'This device has no conversation read grant.',
  })
})

test('a read-only socket is refused commands with the command id', async () => {
  const socket = new Socket()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'c', command: { kind: 'interrupt' } })
  await tick()
  assert.deepEqual(socket.output().at(-1), {
    type: 'commandResult',
    commandId: 'c',
    ok: false,
    code: 'conversation_operate_required',
  })
  stream.close(1000, '')
})

// A provider whose turn streams whatever the test pushes, so a socket can drop
// in the middle of a reply.
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started!: () => void
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve
  })
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
  return { adapter, turnStarted, push: (text: string | null) => push(text) }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

type WireFrame = { type: string; seq?: number; generation?: string; event?: ConversationEvent }
const wireSeqs = (frames: WireFrame[]) => frames.flatMap((frame) => (frame.type === 'event' ? [frame.event!.seq!] : []))

test('a socket dropped mid-turn resumes from its cursor with no gap, duplicate or reset', async () => {
  const provider = pushProvider()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-socket-'))
  const conversation = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({ adapters: [provider.adapter], getProviderById: () => undefined })
  const gateway = createConversationGatewayHost(
    runtime,
    (id) => (id === conversation.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: conversation.workspaceId }],
  )
  const open = () => {
    const socket = new Socket()
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes: ['conversation:read'],
      host: gateway,
      onClosed: () => {},
      audit: () => {},
    })
    return { socket, stream, frames: () => socket.output() as WireFrame[] }
  }
  try {
    const started = await runtime.startSession({
      ...conversation,
      providerId: provider.adapter.id,
      modelId: provider.adapter.listModels()[0],
      permissionPreset: 'manual',
    })
    assert.ok(started.ok)
    const first = open()
    first.socket.receive({ type: 'subscribe', key: { workspaceId: 'workspace', agentId: 'agent' } })
    await waitFor(() => first.frames().some((frame) => frame.type === 'synchronized'), 'first join synchronizes')
    const sending = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'stream' })
    await provider.turnStarted
    for (let index = 0; index < 5; index++) provider.push(`before-${index} `)
    await waitFor(
      () => first.frames().some((frame) => frame.event?.payload?.text === 'before-4 '),
      'live deltas reach the first socket',
    )
    const generation = first.frames().find((frame) => frame.type === 'synchronized')?.generation
    assert.ok(generation, 'the fence names the log generation over the wire')
    const cursor = Math.max(...wireSeqs(first.frames()))
    first.stream.close(1001, '')
    first.socket.destroy()

    // Offline: more of the reply lands and reaches nobody.
    for (let index = 0; index < 5; index++) provider.push(`missed-${index} `)
    const published: number[] = []
    const stopWatching = runtime.onEvent((event) => published.push(event.seq!))
    await waitFor(() => published.length >= 5, 'offline deltas are published')

    const second = open()
    second.socket.receive({
      type: 'subscribe',
      key: { workspaceId: 'workspace', agentId: 'agent' },
      afterSeq: cursor,
      generation,
    })
    // The reply keeps streaming while the reconnect reads its catch-up.
    for (let index = 0; index < 5; index++) provider.push(`during-${index} `)
    await waitFor(() => second.frames().some((frame) => frame.type === 'synchronized'), 'the reconnect synchronizes')
    for (let index = 0; index < 3; index++) provider.push(`after-${index} `)
    provider.push(null)
    await sending
    await waitFor(
      () => second.frames().some((frame) => frame.event?.type === 'turn_completed'),
      'the rest of the turn arrives live',
    )
    stopWatching()

    const frames = second.frames()
    assert.equal(
      frames.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the log can vouch for is not answered with a reset',
    )
    assert.equal(frames.find((frame) => frame.type === 'synchronized')?.generation, generation)
    const seqs = wireSeqs(frames)
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    )
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicates')
    assert.ok(seqs[0] > cursor, 'nothing from before the cursor')
    const text = frames
      .flatMap((frame) => (frame.event?.type === 'content_delta' ? [String(frame.event.payload?.text)] : []))
      .join('')
    const expected = ['missed', 'during', 'after']
      .flatMap((phase) => Array.from({ length: phase === 'after' ? 3 : 5 }, (_, index) => `${phase}-${index} `))
      .join('')
    assert.equal(text, expected, 'every missed and later delta exactly once')
    const transcript = await runtime.readTranscript(conversation, { all: true, closeOpenTurns: false })
    assert.ok(transcript.ok)
    assert.equal(seqs.at(-1), transcript.events.at(-1)!.seq, 'caught up to the end of the log')
    second.stream.close(1000, '')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('remote always and bypass are refused before host execution', async () => {
  const socket = new Socket()
  let commands = 0
  const gateway = host()
  gateway.command = async () => {
    commands++
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({
    type: 'command',
    commandId: 'c1',
    command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
  })
  socket.receive({ type: 'command', commandId: 'c2', command: { kind: 'setPermissionPreset', preset: 'bypass' } })
  await tick()
  assert.equal(commands, 0)
  assert.deepEqual(
    socket
      .output()
      .slice(-2)
      .map((frame) => (frame as { code: string }).code),
    ['unsafe_remote_decision', 'unsafe_remote_preset'],
  )
  stream.close(1000, '')
})

test('a large escaped tool detail is paced and reassembles without a resync close', async () => {
  const socket = new Socket()
  socket.delayMs = 1
  const gateway = host()
  const detail = '😀"\n'.repeat(1_100_000)
  gateway.getToolDetail = async () => ({
    ok: true,
    detail: { input: null, output: detail, status: 'ok', clipped: false },
  })
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'getToolDetail', requestId: 'detail-1', toolUseId: 'tool-1' })
  const started = Date.now()
  while (
    !socket
      .output()
      .some(
        (frame) =>
          (frame as { type: string; index?: number; total?: number }).type === 'chunk' &&
          (frame as { index?: number; total?: number }).index === (frame as { total?: number }).total! - 1,
      )
  ) {
    assert.ok(Date.now() - started < 5_000, 'paced detail completes without stalling')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  const chunks = socket
    .output()
    .filter(
      (frame): frame is { type: 'chunk'; index: number; total: number; json: string } =>
        (frame as { type: string }).type === 'chunk',
    )
  assert.ok(chunks.length > 64, 'detail requires more chunks than the bounded pending-frame queue')
  assert.equal(stream.isClosed(), false)
  const reassembled = JSON.parse(
    chunks
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.json)
      .join(''),
  ) as { data: { detail: { output: string } } }
  assert.equal(reassembled.data.detail.output, detail)
  stream.close(1000, '')
})
