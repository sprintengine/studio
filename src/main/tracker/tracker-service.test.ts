import assert from 'node:assert/strict'

import { TrackerConnectionStore, type TrackerConnectionStoreOptions } from './connection-store'
import { TrackerService } from './tracker-service'
import { TrackerWriteBackConfigStore } from './writeback/config-store'
import { TrackerWriteBackLedger } from './writeback/ledger'

// Verifies TrackerService.removeConnection cleans up write-back state (MC-1730
// item 1): removing a connection drops its write-back config so anyActive() falls
// to false (a dead connection no longer makes every run op pay the backlog scan,
// nor retries not_configured posts), and clears its ledger entries so a removed
// connection's failure notices don't outlive it. Cleanup is best-effort — a
// cleanup hiccup never fails the removal.

async function main(): Promise<void> {
  await testRemoveConnectionDropsWriteBackConfigAndLedger()
  await testRemovalSucceedsEvenIfCleanupThrows()

  console.log('tracker-service tests passed')
}

async function testRemoveConnectionDropsWriteBackConfigAndLedger(): Promise<void> {
  const connectionStore = createConnectionStore()
  const configStore = new TrackerWriteBackConfigStore({ resolveUserDataDir: () => '/ud', files: stringMemoryFs() })
  const ledger = new TrackerWriteBackLedger({ resolveUserDataDir: () => '/ud', files: stringMemoryFs() })
  const service = new TrackerService({
    connectionStore,
    writeBackCleanup: {
      removeConfig: (id) => configStore.remove(id),
      dropLedger: (id) => ledger.dropConnection(id),
    },
  })

  const connection = await connectionStore.add({
    provider: 'jira',
    baseUrl: 'https://acme.atlassian.net',
    authMode: 'jira_basic',
    label: 'Acme',
  })
  await configStore.set(connection.id, {
    enabled: true,
    comments: { started: true, pr: true, done: true },
    transitions: { onStart: null, onComplete: null },
  })
  await ledger.recordFailure({
    key: `run|comment:started|${connection.id}`,
    statePath: '/ws/team/run.yaml',
    connectionId: connection.id,
    externalId: '10023',
    provider: 'jira',
    postKind: 'comment:started',
    relativePath: 'backlog/x.md',
    at: '2026-07-19T12:00:00.000Z',
    message: 'boom',
  })

  assert.equal(await configStore.anyActive(), true)
  assert.equal((await ledger.listNotices()).length, 1)

  const result = await service.removeConnection({ connectionId: connection.id })
  assert.equal(result.ok, true)

  // The write-back config is gone (anyActive → false) and the dead connection's
  // ledger notice is cleared.
  assert.equal(await configStore.anyActive(), false)
  assert.equal((await ledger.listNotices()).length, 0)
  assert.deepEqual(await connectionStore.list(), [])
}

async function testRemovalSucceedsEvenIfCleanupThrows(): Promise<void> {
  const service = new TrackerService({
    connectionStore: createConnectionStore(),
    writeBackCleanup: {
      removeConfig: async () => {
        throw new Error('config store unavailable')
      },
      dropLedger: async () => {
        throw new Error('ledger unavailable')
      },
    },
  })

  // The connection is already gone once connectionStore.remove resolves, so a
  // cleanup failure must not surface as a failed removal.
  const result = await service.removeConnection({ connectionId: 'trk-missing' })
  assert.equal(result.ok, true)
}

let idCounter = 0

function createConnectionStore(): TrackerConnectionStore {
  return new TrackerConnectionStore({
    resolveUserDataDir: () => '/user-data',
    files: bufferMemoryFs(),
    env: {},
    generateConnectionId: () => `trk-s${++idCounter}`,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`),
      decryptString: (value) => value.toString('utf-8').replace(/^enc:/, ''),
    },
  })
}

// The connection store's adapter is Buffer-backed with unlink (matches
// connection-store.test.ts).
function bufferMemoryFs(): NonNullable<TrackerConnectionStoreOptions['files']> {
  const files = new Map<string, Buffer>()
  return {
    mkdir: async () => undefined,
    readFile: async (path: unknown, encoding?: unknown) => {
      const value = files.get(String(path))
      if (!value) throw new Error('missing')
      return encoding ? value.toString('utf8') : value
    },
    writeFile: async (path: unknown, data: unknown) => {
      files.set(String(path), Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    },
    unlink: async (path: unknown) => {
      files.delete(String(path))
    },
  } as unknown as NonNullable<TrackerConnectionStoreOptions['files']>
}

// The write-back stores' adapter is string-backed with rename.
function stringMemoryFs() {
  const files = new Map<string, string>()
  return {
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
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
