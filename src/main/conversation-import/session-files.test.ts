// Reading a CLI's saved transcripts a line at a time: a reader that stops
// early lets the file go.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test, vi } from 'vitest'

const opened = vi.hoisted(() => [] as ReadStream[])

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      opened.push(stream)
      return stream
    },
  }
})

const { readJsonLines } = await import('./session-files')

const scratch = mkdtempSync(join(tmpdir(), 'se-session-files-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function transcript(name: string, count: number): string {
  const path = join(scratch, name)
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({ index }))
  writeFileSync(path, `${lines.join('\n')}\nnot json\n`)
  return path
}

test('every record comes back in order, and a line that is not JSON is skipped', async () => {
  const path = transcript('all.jsonl', 3)
  const records: unknown[] = []
  for await (const record of readJsonLines(path)) records.push(record)
  assert.deepEqual(records, [{ index: 0 }, { index: 1 }, { index: 2 }])
})

test('a reader that stops after the first records lets the file go', async () => {
  const path = transcript('early.jsonl', 5_000)
  opened.length = 0
  for await (const record of readJsonLines(path)) {
    if (record.index === 2) break
  }
  assert.equal(opened.length, 1)
  assert.equal(opened[0]!.destroyed, true, 'the read stream, and its descriptor, are closed')
})
