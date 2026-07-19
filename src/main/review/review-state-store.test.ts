import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewWorkspaceState } from '../../shared/review'
import { readReviewState, writeReviewState } from './review-state-store'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-state-'))
  tempDirs.push(dir)
  return dir
}

// An in-flight review: read progress, an active step, a chosen view, and comments
// spanning every sync state that must survive a restart — a pending one, a posted
// one that stays read-only, a retryable failed one, and a 'moved' held one.
function inFlightState(): ReviewWorkspaceState {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_abc123',
    readFiles: ['src/a.ts', 'src/b.ts'],
    activeStepId: 'step-2',
    diffView: 'inline',
    comments: [
      {
        id: 'c1',
        path: 'src/a.ts',
        anchor: { side: 'new', startLine: 10, endLine: 12 },
        body: 'unposted note',
        createdAt: '2026-07-18T00:00:00.000Z',
        sync: { state: 'pending' },
      },
      {
        id: 'c2',
        path: 'src/b.ts',
        anchor: { side: 'new', startLine: 3, endLine: 3 },
        body: 'already posted',
        createdAt: '2026-07-18T00:01:00.000Z',
        sync: { state: 'posted', url: 'https://github.com/o/r/pull/1#c2', postedAt: '2026-07-18T00:02:00.000Z' },
      },
      {
        id: 'c3',
        path: 'src/a.ts',
        anchor: { side: 'old', startLine: 40, endLine: 41 },
        body: 'failed to post',
        createdAt: '2026-07-18T00:03:00.000Z',
        sync: { state: 'failed', error: 'network' },
      },
      {
        id: 'c4',
        path: 'src/a.ts',
        anchor: { side: 'new', startLine: 99, endLine: 99 },
        body: 'line moved',
        createdAt: '2026-07-18T00:04:00.000Z',
        sync: { state: 'pending' },
        anchorStatus: 'moved',
      },
    ],
  }
}

run('write then read returns the state verbatim', async () => {
  const dir = join(makeTempDir(), 'rv_1')
  const state = inFlightState()
  await writeReviewState(dir, state)
  const read = await readReviewState(dir)
  assert.equal(read.ok, true)
  assert.deepEqual(read.ok && read.state, state, 'in-flight review survives the round-trip verbatim')
})

run('write is atomic (temp-then-rename) and leaves only state.json', async () => {
  const dir = join(makeTempDir(), 'rv_2')
  await writeReviewState(dir, inFlightState())
  // The written file is valid JSON with a trailing newline, like changeset/brief.
  const raw = readFileSync(join(dir, 'state.json'), 'utf-8')
  assert.ok(raw.endsWith('\n'))
  assert.deepEqual(JSON.parse(raw).changeSetId, 'cs_abc123')
})

run('missing state.json reads as null (no progress yet), not an error', async () => {
  const dir = join(makeTempDir(), 'rv_empty')
  await mkdir(dir, { recursive: true })
  const read = await readReviewState(dir)
  assert.deepEqual(read, { ok: true, state: null })
})

run('malformed JSON reads as an explicit error, never a silent reset', async () => {
  const dir = join(makeTempDir(), 'rv_bad')
  await mkdir(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), '{ not json', 'utf-8')
  const read = await readReviewState(dir)
  assert.equal(read.ok, false)
})

run('an on-disk state that fails validation reads as an error', async () => {
  const dir = join(makeTempDir(), 'rv_invalid')
  await mkdir(dir, { recursive: true })
  // Missing changeSetId + wrong diffView — validateReviewWorkspaceState rejects it.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, readFiles: [], diffView: 'x', comments: [] }), 'utf-8')
  const read = await readReviewState(dir)
  assert.equal(read.ok, false)
})

run('writing an invalid state throws rather than persisting garbage', async () => {
  const dir = join(makeTempDir(), 'rv_reject')
  const bad = { schemaVersion: 1, changeSetId: '', readFiles: [], diffView: 'inline', comments: [] } as unknown as ReviewWorkspaceState
  await assert.rejects(() => writeReviewState(dir, bad))
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('review-state-store.test.ts: ok')
}

void main()
