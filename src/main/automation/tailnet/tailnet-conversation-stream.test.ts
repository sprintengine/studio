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
import { createResyncBackoff, createTailnetConversationStream } from './tailnet-conversation-stream'
import { createWebSocketFrameDecoder, encodeMaskedTextFrame } from './websocket-frames'
import { conversationCloseRetryAfterMs } from '../../../../packages/conversation-protocol/src'

class Socket extends Duplex {
  // Every write in the order the stream made it: what the peer would read.
  frames: Buffer[] = []
  delayMs = 0
  // A peer that has stopped reading: no write ever completes.
  stalled = false
  _read(): void {}
  override write(chunk: Buffer, encoding?: unknown, callback?: unknown): boolean {
    this.frames.push(chunk)
    return (super.write as (...args: unknown[]) => boolean).call(this, chunk, encoding, callback)
  }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.stalled) return
    if (this.delayMs) setTimeout(done, this.delayMs)
    else done()
  }
  closeFrame(): { code: number; reason: string } | undefined {
    const decoded = createWebSocketFrameDecoder(256 * 1024, 'client').push(Buffer.concat(this.frames))
    if (decoded.kind !== 'frames') return undefined
    const close = decoded.frames.find((frame) => frame.kind === 'close')
    return close?.kind === 'close' ? { code: close.code, reason: close.reason } : undefined
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

type Frame = {
  type: string
  seq?: number
  code?: string
  requestId?: string
  retryAfterMs?: number
  event?: ConversationEvent
  page?: { events: ConversationEvent[]; hasMore: boolean; beforeCursor: number | null }
  part?: { index: number; total: number }
  frameId?: string
  index?: number
  total?: number
  json?: string
}

/** Wire frames with every chunked frame reassembled in its place. */
function assemble(frames: unknown[]): Frame[] {
  const assembled: Frame[] = []
  const chunks = new Map<string, string[]>()
  for (const frame of frames as Frame[]) {
    if (frame.type !== 'chunk') {
      assembled.push(frame)
      continue
    }
    const parts = chunks.get(frame.frameId!) ?? []
    parts[frame.index!] = frame.json!
    chunks.set(frame.frameId!, parts)
    if (parts.filter((part) => part !== undefined).length === frame.total)
      assembled.push(JSON.parse(parts.join('')) as Frame)
  }
  return assembled
}

function wireEvent(seq: number, type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'p',
    modelId: 'm',
    type,
    createdAt: seq,
    payload,
  }
}

/** A subscribed socket whose join the test drives frame by frame. */
async function joinedSocket(configure: (gateway: ConversationGatewayHost) => void = () => {}) {
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
  configure(gateway)
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
    resyncRetryAfterMs: () => 4_000,
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  return { socket, stream, emit: (frame: ConversationSessionFrame) => listener(frame), disposed: () => disposed }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - started < 10_000, what)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a slow reader gets a streaming reply merged into waiting frames instead of a resync', async () => {
  const { socket, stream, emit } = await joinedSocket()
  emit({ type: 'synchronized', seq: 0 })
  socket.delayMs = 1
  let seq = 0
  const expected: string[] = []
  for (let index = 0; index < 3_000; index++) {
    const text = `word-${index} `
    expected.push(text)
    emit({ type: 'event', event: wireEvent(++seq, 'content_delta', { turnId: 't', text }) })
    // A tool's partial output streams alongside; only its newest one matters.
    if (index % 10 === 0)
      emit({
        type: 'event',
        event: wireEvent(++seq, 'tool_output', { toolUseId: 'tool', partial: true, preview: `line ${index}` }),
      })
  }
  emit({ type: 'event', event: wireEvent(++seq, 'turn_completed', { turnId: 't' }) })
  await until(() => assemble(socket.output()).some((frame) => frame.event?.type === 'turn_completed'), 'turn ends')
  assert.equal(stream.isClosed(), false)
  const frames = assemble(socket.output()).filter((frame) => frame.type === 'event')
  assert.ok(frames.length < 100, `a stalled reply is a handful of frames, not ${frames.length}`)
  const seqs = frames.map((frame) => frame.event!.seq!)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  )
  assert.equal(seqs.at(-1), seq)
  const text = frames
    .filter((frame) => frame.event!.type === 'content_delta')
    .map((frame) => frame.event!.payload!.text)
    .join('')
  assert.equal(text, expected.join(''), 'merging never loses or reorders text')
  const outputs = frames.filter((frame) => frame.event!.type === 'tool_output')
  assert.equal(outputs.at(-1)!.event!.payload!.preview, 'line 2990')
  stream.close(1000, '')
})

test('a reader that stops reading is closed once with a resync and an advised retry delay', async () => {
  const joined = await joinedSocket()
  joined.socket.stalled = true
  joined.emit({ type: 'synchronized', seq: 0 })
  for (let seq = 1; seq <= 400; seq++)
    joined.emit({ type: 'event', event: wireEvent(seq, 'tool_started', { toolUseId: `tool-${seq}` }) })
  assert.equal(joined.stream.isClosed(), true)
  assert.equal(joined.disposed(), 1)
  const frames = joined.socket.output() as Frame[]
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'error').map((frame) => [frame.code, frame.retryAfterMs]),
    [['resync_required', 4_000]],
  )
  assert.deepEqual(joined.socket.closeFrame(), { code: 4409, reason: 'resync_required;retryAfterMs=4000' })
  assert.equal(conversationCloseRetryAfterMs(joined.socket.closeFrame()!.reason), 4_000)
})

test('a read flood is answered busy while the socket stays open', async () => {
  const { socket, stream } = await joinedSocket((gateway) => {
    gateway.list = () => new Promise(() => {})
  })
  for (let index = 0; index < 20; index++) socket.receive({ type: 'list', requestId: `list-${index}` })
  await tick()
  assert.equal(stream.isClosed(), false)
  const busy = (socket.output() as Frame[]).filter((frame) => frame.code === 'busy')
  // The subscribe finished; four lists hold every read slot.
  assert.deepEqual(
    busy.map((frame) => frame.requestId),
    Array.from({ length: 16 }, (_, index) => `list-${index + 4}`),
  )
  assert.ok(busy.every((frame) => frame.type === 'result' && (frame.retryAfterMs ?? 0) > 0))
  stream.close(1000, '')
})

test('a large snapshot streams in parts while live events keep arriving, without a resync', async () => {
  const { socket, stream, emit } = await joinedSocket()
  socket.delayMs = 1
  const events = Array.from({ length: 400 }, (_, index) =>
    wireEvent(index + 1, 'tool_output', { toolUseId: `t${index}`, preview: 'x'.repeat(20_000) }),
  )
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 1 }, generation: 'g' })
  emit({ type: 'synchronized', seq: 400, generation: 'g' })
  let seq = 400
  for (let index = 0; index < 2_000; index++)
    emit({ type: 'event', event: wireEvent(++seq, 'content_delta', { turnId: 't', text: `${index},` }) })
  for (let index = 0; index < 100; index++)
    emit({ type: 'event', event: wireEvent(++seq, 'tool_started', { toolUseId: `live-${index}` }) })
  await until(() => assemble(socket.output()).some((frame) => frame.event?.seq === seq), 'live events drain')
  assert.equal(stream.isClosed(), false)
  const frames = assemble(socket.output())
  const parts = frames.filter((frame) => frame.type === 'snapshot')
  assert.ok(parts.length > 1, 'a snapshot bigger than a frame arrives in parts')
  assert.deepEqual(
    parts.map((frame) => frame.part),
    parts.map((_, index) => ({ index, total: parts.length })),
  )
  assert.deepEqual(
    parts.flatMap((frame) => frame.page!.events.map((event) => event.seq)),
    events.map((event) => event.seq),
  )
  const fence = frames.findIndex((frame) => frame.type === 'synchronized')
  assert.ok(fence > frames.indexOf(parts.at(-1)!), 'the fence follows the whole snapshot')
  assert.ok(frames.slice(0, fence).every((frame) => frame.type === 'snapshot'))
  const live = frames.slice(fence + 1)
  assert.equal(
    live
      .filter((frame) => frame.event?.type === 'content_delta')
      .map((frame) => frame.event!.payload!.text)
      .join(''),
    Array.from({ length: 2_000 }, (_, index) => `${index},`).join(''),
  )
  stream.close(1000, '')
})

test('a snapshot beyond the frame budget keeps its newest events and pages the rest', async () => {
  const { socket, stream, emit } = await joinedSocket()
  const events = Array.from({ length: 40 }, (_, index) =>
    wireEvent((index + 1) * 10, 'user_message', { text: 'y'.repeat(1024 * 1024) }),
  )
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 10 }, reset: true, generation: 'g' })
  emit({ type: 'synchronized', seq: 400, generation: 'g' })
  await until(() => assemble(socket.output()).some((frame) => frame.type === 'synchronized'), 'snapshot drains')
  assert.equal(stream.isClosed(), false)
  const parts = assemble(socket.output()).filter((frame) => frame.type === 'snapshot')
  const kept = parts.flatMap((frame) => frame.page!.events.map((event) => event.seq!))
  assert.ok(kept.length > 0 && kept.length < events.length)
  assert.deepEqual(
    kept,
    events.slice(events.length - kept.length).map((event) => event.seq),
  )
  for (const part of parts) {
    assert.equal(part.page!.hasMore, true)
    assert.equal(part.page!.beforeCursor, kept[0], 'the rest is one loadEarlier away')
  }
  stream.close(1000, '')
})

test('resync delays double for a device that keeps falling behind and reset after a quiet spell', () => {
  let clock = 0
  const backoff = createResyncBackoff(() => clock)
  assert.deepEqual(
    Array.from({ length: 8 }, () => backoff('phone')),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
  )
  assert.equal(backoff('tablet'), 1_000, 'per device')
  clock += 10 * 60_000
  assert.equal(backoff('phone'), 1_000)
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
  listeners[1]({ type: 'synchronized', seq: 1 })
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
  assert.deepEqual(
    socket.output().map((frame) => (frame as { type: string }).type),
    ['synchronized', 'event'],
  )
  const output = JSON.stringify(socket.output())
  assert.equal(output.includes(homedir()), false)
  assert.equal(output.includes('test-secret'), false)
  assert.ok(output.includes('[home]/project/file'))
  stream.close(1000, 'device_revoked')
  listeners[1]({ type: 'synchronized', seq: 3 })
  assert.equal(socket.output().length, 2)
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
    // Deltas published together may arrive merged into one; only the text counts.
    const received = (frames: WireFrame[]) =>
      frames
        .flatMap((frame) => (frame.event?.type === 'content_delta' ? [String(frame.event.payload?.text)] : []))
        .join('')
    await waitFor(() => received(first.frames()).endsWith('before-4 '), 'live deltas reach the first socket')
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
    const text = received(frames)
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
