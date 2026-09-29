import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import {
  ConversationEventLog,
  DEFAULT_DELTA_FLUSH_MS,
  expandCoalescedDeltas,
  type AppendStream,
} from './conversation-event-log'
import { ConversationTranscriptReader } from './conversation-transcript-reader'

let sequence = 0

function event(type: ConversationEventType, payload?: Record<string, unknown>): ConversationEvent {
  sequence += 1
  return {
    id: `evt_${sequence}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type,
    createdAt: 1_000 + sequence,
    ...(payload ? { payload } : {}),
  }
}

/** An in-memory stream that records every write, so tests can count them. */
function recordingStreams() {
  const writes: string[] = []
  const opened: string[] = []
  let closed = 0
  const openStream = async (filePath: string): Promise<AppendStream> => {
    opened.push(filePath)
    return {
      write: async (chunk) => {
        writes.push(chunk)
      },
      close: async () => {
        closed += 1
      },
    }
  }
  return {
    openStream,
    writes,
    opened,
    get closed() {
      return closed
    },
    lines: () =>
      writes
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConversationEvent & { parts?: unknown }),
  }
}

beforeEach(() => {
  sequence = 0
})

afterEach(() => {
  vi.useRealTimers()
})

test('a run of deltas is one write, flushed by the boundary that ends it', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  await log.append('/t.jsonl', event('turn_started', { turnId: 't1' }))
  const deltas = ['Hel', 'lo', ', ', 'world'].map((text) =>
    log.append('/t.jsonl', event('content_delta', { turnId: 't1', text })),
  )
  await Promise.resolve()
  // Nothing written for the deltas yet: they sit in the run.
  assert.equal(streams.writes.length, 1)
  assert.equal(await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' })), 'written')
  assert.deepEqual(await Promise.all(deltas), ['written', 'written', 'written', 'written'])
  assert.equal(streams.writes.length, 2, 'the run and its boundary go out as one chunk')
  const lines = streams.lines()
  assert.deepEqual(
    lines.map((line) => line.type),
    ['turn_started', 'content_delta', 'turn_completed'],
  )
  assert.equal(lines[1].payload?.text, 'Hello, world')
  assert.equal(streams.opened.length, 1, 'one stream for the whole turn')
})

test('reading a merged run back yields the exact deltas that were emitted', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  const emitted = [
    event('reasoning_delta', { turnId: 't1', text: 'think' }),
    event('reasoning_delta', { turnId: 't1', text: 'ing…' }),
    event('content_delta', { turnId: 't1', text: 'An ' }),
    event('content_delta', { turnId: 't1', text: 'answer 🎉' }),
    event('tool_started', { turnId: 't1', tool: 'Read' }),
    event('content_delta', { turnId: 't1', text: 'after' }),
    event('turn_completed', { turnId: 't1' }),
  ]
  await Promise.all(emitted.map((item) => log.append('/t.jsonl', item)))
  const replayed = streams.lines().flatMap(expandCoalescedDeltas)
  assert.deepEqual(replayed, emitted)
})

test('deltas of different turns or kinds never merge', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'a' }))
  void log.append('/t.jsonl', event('content_delta', { turnId: 't2', text: 'b' }))
  void log.append('/t.jsonl', event('reasoning_delta', { turnId: 't2', text: 'c' }))
  void log.append('/t.jsonl', event('content_delta', { turnId: 't2', text: 'd', extra: true }))
  await log.flush()
  const lines = streams.lines()
  assert.equal(lines.length, 4)
  assert.ok(lines.every((line) => line.parts === undefined))
  assert.equal(lines[3].payload?.extra, true, 'a delta with a payload this log does not know is kept whole')
})

test('deltas are written within the short default window, not held for the next boundary', async () => {
  vi.useFakeTimers()
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream })
  let settled = false
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'one ' }))
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'two ' })).then(() => {
    settled = true
  })
  assert.equal(streams.writes.length, 0)
  assert.equal(settled, false, 'an append does not settle before its batch is on disk')
  await vi.advanceTimersByTimeAsync(DEFAULT_DELTA_FLUSH_MS)
  assert.ok(DEFAULT_DELTA_FLUSH_MS <= 50)
  assert.equal(streams.writes.length, 1)
  assert.equal(settled, true)
  assert.equal(streams.lines()[0].payload?.text, 'one two ')
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'three' }))
  await vi.advanceTimersByTimeAsync(DEFAULT_DELTA_FLUSH_MS)
  const replayed = streams.lines().flatMap(expandCoalescedDeltas)
  assert.equal(replayed.map((item) => item.payload?.text).join(''), 'one two three')
  assert.deepEqual(
    replayed.map((item) => item.id),
    ['evt_1', 'evt_2', 'evt_3'],
  )
})

test('close flushes and releases the stream; the next append reopens it', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  const kept = log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'kept' }))
  await log.close('/t.jsonl')
  assert.equal(await kept, 'written')
  assert.equal(streams.closed, 1)
  assert.equal(streams.lines()[0].payload?.text, 'kept')
  await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' }))
  assert.equal(streams.opened.length, 2)
  await log.closeAll()
  assert.equal(streams.closed, 2)
})

test('flush waits for a close of that file still in flight', async () => {
  // A write that only lands when the test says so: the idle sweep's `void
  // close()` has detached the log, and its last chunk is still on its way.
  const writes: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const log = new ConversationEventLog({
    flushDelayMs: 60_000,
    openStream: async () => ({
      write: async (chunk) => {
        await gate
        writes.push(chunk)
      },
      close: async () => undefined,
    }),
  })
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'tail' }))
  const closing = log.close('/t.jsonl')
  let flushed = false
  const flushing = log.flush('/t.jsonl').then(() => {
    flushed = true
  })
  let flushedAll = false
  const flushingAll = log.flush().then(() => {
    flushedAll = true
  })
  let closedAgain = false
  const closingAgain = log.close('/t.jsonl').then(() => {
    closedAgain = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(flushed, false, 'flush(file) does not settle before the closing write lands')
  assert.equal(flushedAll, false, 'flush() waits for closing files too')
  assert.equal(closedAgain, false, 'a second close waits for the first')
  release()
  await Promise.all([closing, flushing, flushingAll, closingAgain])
  assert.equal(writes.length, 1)
  assert.match(writes[0], /"text":"tail"/)
})

test('a failed write is reported, never thrown, and the next write reopens', async () => {
  const errors: unknown[] = []
  let attempt = 0
  const log = new ConversationEventLog({
    flushDelayMs: 60_000,
    onError: (_path, error) => errors.push(error),
    openStream: async () => {
      attempt += 1
      const broken = attempt === 1
      return {
        write: async () => {
          if (broken) throw new Error('disk gone')
        },
        close: async () => undefined,
      }
    },
  })
  assert.equal(await log.append('/t.jsonl', event('turn_started', { turnId: 't1' })), 'failed')
  assert.equal(errors.length, 1)
  assert.equal(await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' })), 'written')
  assert.equal(errors.length, 1)
  assert.equal(attempt, 2)
})

test('a write that never settles fails after the timeout instead of stalling every later event', async () => {
  const errors: unknown[] = []
  let opened = 0
  const log = new ConversationEventLog({
    writeTimeoutMs: 30,
    onError: (_path, error) => errors.push(error),
    openStream: async () => {
      const first = ++opened === 1
      return {
        write: (chunk) => (first ? new Promise<void>(() => undefined) : Promise.resolve(void chunk)),
        close: async () => undefined,
      }
    },
  })
  assert.equal(await log.append('/t.jsonl', event('turn_started', { turnId: 't1' })), 'failed')
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as Error).message), /took longer than 30 ms/)
  assert.equal(await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' })), 'written')
  assert.equal(opened, 2, 'the stuck stream is abandoned and a fresh one takes the next write')
  await log.closeAll()
})

test('the default stream appends to a real file, creating its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-event-log-'))
  try {
    const filePath = join(root, 'nested', 'agent.jsonl')
    const log = new ConversationEventLog({ flushDelayMs: 60_000 })
    const emitted = [
      event('turn_started', { turnId: 't1' }),
      event('content_delta', { turnId: 't1', text: 'a' }),
      event('content_delta', { turnId: 't1', text: 'b' }),
      event('turn_completed', { turnId: 't1' }),
    ]
    await Promise.all(emitted.map((item) => log.append(filePath, item, root)))
    await log.closeAll()
    const raw = await readFile(filePath, 'utf-8')
    assert.equal(raw.trim().split('\n').length, 3)
    const replayed = raw
      .trim()
      .split('\n')
      .flatMap((line) => expandCoalescedDeltas(JSON.parse(line) as ConversationEvent))
    assert.deepEqual(replayed, emitted)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an append after a torn last line starts a line of its own and stays readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-event-log-'))
  try {
    const filePath = join(root, 'agent.jsonl')
    const first = { ...event('turn_started', { turnId: 't1' }), seq: 1 }
    const torn = JSON.stringify({ ...event('content_delta', { turnId: 't1', text: 'lost' }), seq: 2 })
    // What a crash or a full disk leaves behind: a record cut off mid-line.
    await writeFile(filePath, `${JSON.stringify(first)}\n${torn.slice(0, 20)}`, { mode: 0o600 })
    const log = new ConversationEventLog()
    const next = { ...event('user_message', { text: 'hi' }), seq: 3 }
    assert.equal(await log.append(filePath, next, root), 'written')
    const after = { ...event('turn_completed', { turnId: 't1' }), seq: 4 }
    assert.equal(await log.append(filePath, after, root), 'written')
    await log.closeAll()
    const seqs = (await new ConversationTranscriptReader().tail(root, filePath)).map((item) => item.seq)
    assert.deepEqual(seqs, [1, 3, 4], 'every event reported written is readable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a merged record whose parts do not add up is read as one delta, not split wrongly', () => {
  const record = {
    ...event('content_delta', { turnId: 't1', text: 'abc' }),
    parts: [
      ['x', 1, 1],
      ['y', 2, 5],
    ],
  } as ConversationEvent
  const expanded = expandCoalescedDeltas(record)
  assert.equal(expanded.length, 1)
  assert.equal(expanded[0].payload?.text, 'abc')
  assert.equal('parts' in expanded[0], false)
})

test('an append settles only once its batch is on disk', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: string[] = []
  const log = new ConversationEventLog({
    openStream: async () => ({
      write: async (chunk) => {
        await gate
        writes.push(chunk)
      },
      close: async () => undefined,
    }),
  })
  let settled = false
  const appended = log.append('/t.jsonl', event('turn_started', { turnId: 't1' })).then((outcome) => {
    settled = true
    return outcome
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  release()
  assert.equal(await appended, 'written')
  assert.equal(writes.length, 1)
  await log.closeAll()
})

test('a partial tool output replaces the queued one for its tool, and the final output replaces both', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  const output = (preview: string, partial: boolean, toolUseId = 'tool-a') =>
    log.append('/t.jsonl', {
      ...event('tool_output', { turnId: 't1', toolUseId, preview, ...(partial ? { partial: true } : {}) }),
      seq: sequence,
    })
  const first = output('1', true)
  const other = output('x', true, 'tool-b')
  const second = output('12', true)
  await log.flush()
  assert.deepEqual(await Promise.all([first, other, second]), ['superseded', 'written', 'written'])
  assert.deepEqual(
    streams.lines().map((line) => [line.payload?.toolUseId, line.payload?.preview]),
    [
      ['tool-b', 'x'],
      ['tool-a', '12'],
    ],
  )
  const third = output('123', true)
  const final = output('1234', false)
  assert.deepEqual(await Promise.all([third, final]), ['superseded', 'written'])
  assert.deepEqual(
    streams.lines().map((line) => line.payload?.preview),
    ['x', '12', '1234'],
  )
})

test('partial tool output waits longer than deltas, but a delta behind it takes it along', async () => {
  vi.useFakeTimers()
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, toolOutputFlushDelayMs: 500 })
  void log.append('/t.jsonl', event('tool_output', { turnId: 't1', toolUseId: 'a', preview: 'p', partial: true }))
  await vi.advanceTimersByTimeAsync(DEFAULT_DELTA_FLUSH_MS)
  assert.equal(streams.writes.length, 0)
  void log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'd' }))
  await vi.advanceTimersByTimeAsync(DEFAULT_DELTA_FLUSH_MS)
  assert.equal(streams.writes.length, 1)
  assert.deepEqual(
    streams.lines().map((line) => line.type),
    ['tool_output', 'content_delta'],
  )
})

test('closeAll also closes a stream an append opened while the first pass was closing', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream })
  await log.append('/a.jsonl', event('turn_started', { turnId: 't1' }))
  const closing = log.closeAll()
  const late = log.append('/b.jsonl', event('turn_started', { turnId: 't2' }))
  await closing
  assert.equal(await late, 'written')
  assert.equal(streams.opened.length, 2)
  assert.equal(streams.closed, 2)
})

test('findLast with a byte budget stops looking past it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-event-log-'))
  try {
    const filePath = join(root, 'agent.jsonl')
    const old = { ...event('tool_started', { toolUseId: 'old' }), seq: 1 }
    const filler = Array.from({ length: 40 }, (_, index) => ({
      ...event('tool_output', { toolUseId: 'filler', output: 'x'.repeat(1024) }),
      seq: index + 2,
    }))
    const recent = { ...event('tool_started', { toolUseId: 'recent' }), seq: 42 }
    const lines = [old, ...filler, recent].map((item) => JSON.stringify(item)).join('\n')
    await writeFile(filePath, `${lines}\n`, { mode: 0o600 })
    const reader = new ConversationTranscriptReader()
    const find = (id: string, maxBytes?: number) =>
      reader.findLast(root, filePath, (item) => item.payload?.toolUseId === id, maxBytes)
    assert.equal((await find('recent', 4096))?.seq, 42)
    assert.equal(await find('old', 4096), undefined, 'the old step lies past the budget')
    assert.equal((await find('old'))?.seq, 1, 'without a budget it scans back as far as it takes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
