import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import type { ConversationToolDetail, ConversationToolDetailResult } from '../shared/conversation-runtime'
import { TOOL_DETAIL_WRITE_WINDOW_MS, ToolDetailWriteQueue } from './conversation-tool-details'

// The detail-file write queue on a fake clock and an in-memory disk: a running
// tool's updates close together share one write, and nothing that ends the
// tool, reads its file or shuts the app down waits out the window.

const ROOT = '/Users/dev/project'
const PATH = '/Users/dev/project/.sprintengine/conversations/ws/agent.tools/run.json'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function fixture() {
  const disk = new Map<string, ConversationToolDetail>()
  const writes: string[] = []
  const queue = new ToolDetailWriteQueue({
    read: async (_root, path): Promise<ConversationToolDetailResult> => {
      const stored = disk.get(path)
      return stored
        ? { ok: true, detail: structuredClone(stored) }
        : { ok: false, code: 'not_found', message: 'Tool detail is unavailable.' }
    },
    write: async (_root, path, detail) => {
      writes.push(String(detail.output))
      disk.set(path, structuredClone(detail))
    },
  })
  const detail = (output: string): ConversationToolDetail => ({
    input: { command: 'npm test' },
    output,
    status: 'ok',
    clipped: false,
  })
  return { disk, writes, queue, detail }
}

test('updates inside the window collapse into one write of the newest', async () => {
  const f = fixture()
  for (let index = 1; index <= 20; index++)
    void f.queue.queue(ROOT, PATH, f.detail(`line ${index}`), { coalesce: true })
  await vi.advanceTimersByTimeAsync(TOOL_DETAIL_WRITE_WINDOW_MS - 1)
  assert.deepEqual(f.writes, [], 'nothing is written before the window ends')
  await vi.advanceTimersByTimeAsync(1)
  assert.deepEqual(f.writes, ['line 20'])
})

test('updates after a window has written start a window of their own', async () => {
  const f = fixture()
  void f.queue.queue(ROOT, PATH, f.detail('first'), { coalesce: true })
  await vi.advanceTimersByTimeAsync(TOOL_DETAIL_WRITE_WINDOW_MS)
  void f.queue.queue(ROOT, PATH, f.detail('second'), { coalesce: true })
  void f.queue.queue(ROOT, PATH, f.detail('third'), { coalesce: true })
  await vi.advanceTimersByTimeAsync(TOOL_DETAIL_WRITE_WINDOW_MS)
  assert.deepEqual(f.writes, ['first', 'third'])
})

test('a write that is not coalesced, such as a tool’s start, goes at once', async () => {
  const f = fixture()
  await f.queue.queue(ROOT, PATH, f.detail(''))
  assert.deepEqual(f.writes, [''])
})

test('a final output releases a waiting update at once, as one write of the final', async () => {
  const f = fixture()
  void f.queue.queue(ROOT, PATH, f.detail('running'), { coalesce: true })
  await f.queue.queue(ROOT, PATH, f.detail('done'))
  assert.deepEqual(f.writes, ['done'])
  assert.equal(vi.getTimerCount(), 0, 'the window’s timer is gone with it')
})

test('a read that flushes first sees the newest update, without waiting out the window', async () => {
  const f = fixture()
  await f.queue.queue(ROOT, PATH, f.detail(''))
  void f.queue.queue(ROOT, PATH, f.detail('partial 1'), { coalesce: true })
  void f.queue.queue(ROOT, PATH, f.detail('partial 2'), { coalesce: true })
  await f.queue.flush(PATH)
  assert.equal(f.disk.get(PATH)?.output, 'partial 2')
  assert.deepEqual(f.writes, ['', 'partial 2'])
})

test('updates arriving while a write is in flight wait behind it and join one write', async () => {
  const f = fixture()
  let land!: () => void
  const landed = new Promise<void>((resolve) => (land = resolve))
  const writes: string[] = []
  const queue = new ToolDetailWriteQueue({
    read: async () => ({ ok: false, code: 'not_found', message: 'Tool detail is unavailable.' }),
    write: async (_root, _path, detail) => {
      writes.push(String(detail.output))
      if (writes.length === 1) await landed
    },
  })
  const first = queue.queue(ROOT, PATH, f.detail('start'))
  // Started, and held on the disk.
  await vi.advanceTimersByTimeAsync(0)
  void queue.queue(ROOT, PATH, f.detail('a'), { coalesce: true })
  void queue.queue(ROOT, PATH, f.detail('b'), { coalesce: true })
  await vi.advanceTimersByTimeAsync(TOOL_DETAIL_WRITE_WINDOW_MS)
  assert.deepEqual(writes, ['start'], 'the next write waits for the one in flight')
  land()
  await first
  await queue.flush(PATH)
  assert.deepEqual(writes, ['start', 'b'])
})

test('a detail first seen mid-stream keeps the input already on disk', async () => {
  const f = fixture()
  f.disk.set(PATH, { input: { command: 'npm run build' }, output: '', status: 'ok', clipped: false })
  const update = { input: {}, output: 'resumed', status: 'ok' as const, clipped: false }
  void f.queue.queue(ROOT, PATH, update, { coalesce: true, mergeInput: true })
  await f.queue.flush(PATH)
  assert.deepEqual(f.disk.get(PATH)?.input, { command: 'npm run build' })
  assert.equal(f.disk.get(PATH)?.output, 'resumed')
})

test('a shutdown writes every update still waiting out its window', async () => {
  const f = fixture()
  const other = PATH.replace('run.json', 'other.json')
  void f.queue.queue(ROOT, PATH, f.detail('one'), { coalesce: true })
  void f.queue.queue(ROOT, other, f.detail('two'), { coalesce: true })
  await f.queue.flushAll()
  assert.deepEqual(f.writes.toSorted(), ['one', 'two'])
  assert.equal(vi.getTimerCount(), 0)
})
