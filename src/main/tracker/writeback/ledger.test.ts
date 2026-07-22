import assert from 'node:assert/strict'

import { TrackerWriteBackLedger } from './ledger'

// Verifies the idempotency + notice ledger (MC-1640 / T10): a posted key blocks a
// repeat; a failed key does NOT (so it retries); a later success clears the
// notice; notices list only currently-failing posts; everything survives a reload
// from disk (the app-restart idempotency guarantee); load-time eviction drops
// entries for gone runs and aged-out legacy entries while keeping live ones; and
// dropConnection clears a removed connection's entries.

const LEDGER_PATH = '/ud/tracker-writeback-ledger.json'

async function main(): Promise<void> {
  await testPostedBlocksRepeatAndFailedDoesNot()
  await testSuccessOverridesFailureNotice()
  await testNoticesListOnlyFailing()
  await testSurvivesReload()
  await testEvictsGoneRunsAndAgedLegacyEntriesOnLoad()
  await testDropConnectionClearsOnlyThatConnection()

  console.log('tracker-writeback-ledger tests passed')
}

async function testPostedBlocksRepeatAndFailedDoesNot(): Promise<void> {
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  const meta = postMeta('key-a')

  assert.equal(await ledger.hasPosted('key-a'), false)
  await ledger.markPosted(meta)
  assert.equal(await ledger.hasPosted('key-a'), true)

  // A failed post is never "posted", so hasPosted stays false and it will retry.
  await ledger.recordFailure(postMeta('key-b', 'boom'))
  assert.equal(await ledger.hasPosted('key-b'), false)
}

async function testSuccessOverridesFailureNotice(): Promise<void> {
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  await ledger.recordFailure(postMeta('key-c', 'rate limited'))
  assert.equal((await ledger.listNotices()).length, 1)

  await ledger.markPosted(postMeta('key-c'))
  assert.equal(await ledger.hasPosted('key-c'), true)
  assert.equal((await ledger.listNotices()).length, 0, 'a success clears the notice')

  // A stale failure racing after the success must not resurrect the notice.
  await ledger.recordFailure(postMeta('key-c', 'late failure'))
  assert.equal((await ledger.listNotices()).length, 0)
  assert.equal(await ledger.hasPosted('key-c'), true)
}

async function testNoticesListOnlyFailing(): Promise<void> {
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  await ledger.markPosted(postMeta('ok'))
  await ledger.recordFailure(postMeta('bad', 'nope'))
  const notices = await ledger.listNotices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].message, 'nope')
  assert.equal(notices[0].externalId, 'ext-1')
}

async function testSurvivesReload(): Promise<void> {
  const fs = memoryFs()
  const first = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: fs.adapter })
  await first.markPosted(postMeta('persisted'))
  assert.ok(fs.files.has(LEDGER_PATH), 'ledger persisted to disk')

  // A fresh instance reading the same file sees the recorded post — the restart
  // path that keeps a mid-run run from double-posting. The run is still on disk,
  // so load-time eviction keeps its entry.
  const reloaded = new TrackerWriteBackLedger({
    resolveUserDataDir: () => '/ud',
    files: fs.adapter,
    runStateExists: async () => true,
  })
  assert.equal(await reloaded.hasPosted('persisted'), true)
}

async function testEvictsGoneRunsAndAgedLegacyEntriesOnLoad(): Promise<void> {
  const fs = memoryFs()
  // Seed a persisted ledger directly with a mix the eviction pass must sort out.
  fs.files.set(
    LEDGER_PATH,
    JSON.stringify({
      version: 1,
      entries: {
        live: seededEntry({ statePath: '/ws/live/run.yaml' }),
        gone: seededEntry({ statePath: '/ws/gone/run.yaml' }),
        'legacy-old': seededEntry({ at: '2020-01-01T00:00:00.000Z' }), // no statePath
        'legacy-recent': seededEntry({ at: '2026-07-19T00:00:00.000Z' }), // no statePath
      },
    })
  )
  const ledger = new TrackerWriteBackLedger({
    resolveUserDataDir: () => '/ud',
    files: fs.adapter,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    // Only the 'live' run's state file still exists on disk.
    runStateExists: async (path) => path === '/ws/live/run.yaml',
  })

  // A gone run can never be reconciled again → its entry is dropped; a live run's
  // entry is kept (idempotency); a legacy entry with no run path ages out past the
  // horizon while a recent one survives.
  assert.equal(await ledger.hasPosted('live'), true)
  assert.equal(await ledger.hasPosted('gone'), false)
  assert.equal(await ledger.hasPosted('legacy-old'), false)
  assert.equal(await ledger.hasPosted('legacy-recent'), true)

  // The file was rewritten to what survived, so the leak does not persist.
  const persisted = JSON.parse(fs.files.get(LEDGER_PATH) as string) as { entries: Record<string, unknown> }
  assert.deepEqual(Object.keys(persisted.entries).sort(), ['legacy-recent', 'live'])
}

async function testDropConnectionClearsOnlyThatConnection(): Promise<void> {
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: memoryFs().adapter })
  await ledger.markPosted(postMeta('a', undefined, { connectionId: 'conn-x' }))
  await ledger.recordFailure(postMeta('b', 'boom', { connectionId: 'conn-x' }))
  await ledger.markPosted(postMeta('c', undefined, { connectionId: 'conn-y' }))

  await ledger.dropConnection('conn-x')

  // conn-x's posted record and failure notice are gone; conn-y is untouched.
  assert.equal(await ledger.hasPosted('a'), false)
  assert.equal(await ledger.hasPosted('c'), true)
  assert.equal((await ledger.listNotices()).length, 0)
}

function postMeta(key: string, message?: string, overrides?: { connectionId?: string }) {
  return {
    key,
    statePath: '/ws/team/run.yaml',
    connectionId: overrides?.connectionId ?? 'conn-1',
    externalId: 'ext-1',
    provider: 'github' as const,
    postKind: 'comment:started' as const,
    relativePath: 'backlog/x.md',
    at: '2026-07-19T12:00:00.000Z',
    ...(message ? { message } : {}),
  }
}

// A persisted entry for the eviction test. `posted` so hasPosted reports it.
function seededEntry(overrides: { statePath?: string; at?: string }) {
  return {
    status: 'posted' as const,
    connectionId: 'conn-1',
    externalId: 'ext-1',
    provider: 'github' as const,
    postKind: 'comment:started' as const,
    relativePath: 'backlog/x.md',
    at: overrides.at ?? '2026-07-19T12:00:00.000Z',
    ...(overrides.statePath ? { statePath: overrides.statePath } : {}),
  }
}

function memoryFs(): { files: Map<string, string>; adapter: { mkdir: any; readFile: any; writeFile: any; rename: any } } {
  const files = new Map<string, string>()
  return {
    files,
    adapter: {
      mkdir: async () => undefined,
      readFile: async (path: string) => {
        if (!files.has(path)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return files.get(path) as string
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, typeof data === 'string' ? data : String(data))
      },
      rename: async (from: string, to: string) => {
        const value = files.get(from)
        if (value === undefined) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        files.set(to, value)
        files.delete(from)
      },
    },
  }
}

void main()
