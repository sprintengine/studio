import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { ConversationEventLog, expandCoalescedDeltas, type AppendStream } from './conversation-event-log'

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
  for (const text of ['Hel', 'lo', ', ', 'world']) {
    await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text }))
  }
  // Nothing written for the deltas yet: they sit in the run.
  assert.equal(streams.writes.length, 1)
  await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' }))
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
  for (const item of emitted) await log.append('/t.jsonl', item)
  const replayed = streams.lines().flatMap(expandCoalescedDeltas)
  assert.deepEqual(replayed, emitted)
})

test('deltas of different turns or kinds never merge', async () => {
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 60_000 })
  await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'a' }))
  await log.append('/t.jsonl', event('content_delta', { turnId: 't2', text: 'b' }))
  await log.append('/t.jsonl', event('reasoning_delta', { turnId: 't2', text: 'c' }))
  await log.append('/t.jsonl', event('content_delta', { turnId: 't2', text: 'd', extra: true }))
  await log.flush()
  const lines = streams.lines()
  assert.equal(lines.length, 4)
  assert.ok(lines.every((line) => line.parts === undefined))
  assert.equal(lines[3].payload?.extra, true, 'a delta with a payload this log does not know is kept whole')
})

test('a timer writes an open run so a crash loses at most the text since the last flush', async () => {
  vi.useFakeTimers()
  const streams = recordingStreams()
  const log = new ConversationEventLog({ openStream: streams.openStream, flushDelayMs: 300 })
  await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'one ' }))
  await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'two ' }))
  assert.equal(streams.writes.length, 0)
  await vi.advanceTimersByTimeAsync(300)
  assert.equal(streams.writes.length, 1)
  assert.equal(streams.lines()[0].payload?.text, 'one two ')
  await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'three' }))
  await vi.advanceTimersByTimeAsync(300)
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
  await log.append('/t.jsonl', event('content_delta', { turnId: 't1', text: 'kept' }))
  await log.close('/t.jsonl')
  assert.equal(streams.closed, 1)
  assert.equal(streams.lines()[0].payload?.text, 'kept')
  await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' }))
  assert.equal(streams.opened.length, 2)
  await log.closeAll()
  assert.equal(streams.closed, 2)
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
  await log.append('/t.jsonl', event('turn_started', { turnId: 't1' }))
  assert.equal(errors.length, 1)
  await log.append('/t.jsonl', event('turn_completed', { turnId: 't1' }))
  assert.equal(errors.length, 1)
  assert.equal(attempt, 2)
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
    for (const item of emitted) await log.append(filePath, item)
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
