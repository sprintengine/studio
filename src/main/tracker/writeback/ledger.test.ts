import assert from 'node:assert/strict'

import { TrackerWriteBackLedger } from './ledger'

// Verifies the idempotency + notice ledger (MC-1640 / T10): a posted key blocks a
// repeat; a failed key does NOT (so it retries); a later success clears the
// notice; notices list only currently-failing posts; and everything survives a
// reload from disk (the app-restart idempotency guarantee).

const LEDGER_PATH = '/ud/tracker-writeback-ledger.json'

async function main(): Promise<void> {
  await testPostedBlocksRepeatAndFailedDoesNot()
  await testSuccessOverridesFailureNotice()
  await testNoticesListOnlyFailing()
  await testSurvivesReload()

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
  // path that keeps a mid-run run from double-posting.
  const reloaded = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: fs.adapter })
  assert.equal(await reloaded.hasPosted('persisted'), true)
}

function postMeta(key: string, message?: string) {
  return {
    key,
    connectionId: 'conn-1',
    externalId: 'ext-1',
    provider: 'github' as const,
    postKind: 'comment:started' as const,
    relativePath: 'backlog/x.md',
    at: '2026-07-19T12:00:00.000Z',
    ...(message ? { message } : {}),
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
