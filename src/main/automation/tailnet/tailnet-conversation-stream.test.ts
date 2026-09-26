import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { test, vi } from 'vitest'
import type { ConversationSessionFrame } from '../../../shared/conversation-runtime'
import type { ConversationGatewayHost } from './tailnet-conversation-host'
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
    subscribe: (_key, afterSeq, _limit, listener) => {
      const ready = Promise.resolve().then(() => {
        for (const seq of [1, 2, 3].filter((candidate) => candidate > (afterSeq ?? 0))) {
          listener({
            type: 'event',
            event: {
              id: `e${seq}`,
              seq,
              sessionId: 's',
              workspaceId: 'w',
              agentId: 'a',
              providerId: 'p',
              modelId: 'm',
              type: 'content_delta',
              createdAt: seq,
              payload: { text: `text ${seq}` },
            },
          })
        }
        listener({ type: 'synchronized', seq: 3 })
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
    gateway.subscribe = (_key, _after, _limit, receive) => {
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
  gateway.subscribe = (_key, _after, _limit, receive) => {
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

test('conversation socket resumes after sequence and fences replay before live', async () => {
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
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' }, afterSeq: 1 })
  await tick()
  assert.deepEqual(
    socket
      .output()
      .map(
        (frame) => (frame as { type: string; event?: { seq: number } }).event?.seq ?? (frame as { type: string }).type,
      ),
    [2, 3, 'synchronized'],
  )
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
