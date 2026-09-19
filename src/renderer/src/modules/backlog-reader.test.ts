import assert from 'node:assert/strict'

import {
  __backlogScanSubscriptionCountForTests,
  __flushBacklogScanForTests,
  __resetBacklogScanSubscriptionsForTests,
  __setBacklogScanRunnerForTests,
  subscribeBacklogScan,
  type BacklogScanSnapshot,
} from '../hooks/useSharedBacklogScan'
import type { BacklogItem, BacklogScanResult } from '../utils/backlog'
import { createBacklogReader } from './backlog-reader'
import { test } from 'vitest'

test('backlog-reader', async () => {
  function item(id: string): BacklogItem {
    return { id, relativePath: `backlog/${id}.md`, status: 'ready' } as unknown as BacklogItem
  }

  function scanResult(items: BacklogItem[]): BacklogScanResult {
    return { state: 'ok', items, errors: [] } as unknown as BacklogScanResult
  }

  const FOLDER = '/tmp/backlog-reader-project'

  // reader.list/watch resolve the folder asynchronously (lazy store import in
  // production); a macrotask hop guarantees the subscription has attached.
  function settleMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  async function testListResolvesFirstSettledSnapshot(): Promise<void> {
    const emitters: Array<(snapshot: BacklogScanSnapshot) => void> = []
    const watcherOptions: Array<boolean | undefined> = []
    let unsubscribed = 0
    const reader = createBacklogReader({
      resolveFolderPath: async (workspaceId) => (workspaceId === 'ws-1' ? FOLDER : null),
      subscribe: (_folderPath, cb, options) => {
        emitters.push(cb)
        watcherOptions.push(options?.startWatcher)
        // Mirror subscribeBacklogScan: the current snapshot lands synchronously.
        cb({ scan: null, loading: true })
        return () => {
          unsubscribed += 1
        }
      },
    })

    const pending = reader.list('ws-1')
    await settleMicrotasks()
    assert.equal(emitters.length, 1)
    emitters[0]!({ scan: scanResult([item('a'), item('b')]), loading: false })
    const items = await pending
    assert.deepEqual(
      items.map((entry) => entry.id),
      ['a', 'b'],
      'list resolves with the settled scan items',
    )
    assert.deepEqual(watcherOptions, [false], 'a one-shot list never spins up the filesystem watcher')
    await settleMicrotasks()
    assert.equal(unsubscribed, 1, 'list is a one-shot ride — it unsubscribes after resolving')

    await assert.rejects(
      () => reader.list('ws-unknown'),
      /has no project folder/,
      'an unresolvable workspace is a descriptive rejection',
    )
  }

  async function testListResolvesImmediatelyFromCachedSnapshot(): Promise<void> {
    let unsubscribed = 0
    const reader = createBacklogReader({
      resolveFolderPath: async () => FOLDER,
      subscribe: (_folderPath, cb) => {
        // A sibling panel already populated this folder: the immediate snapshot
        // is settled, before subscribe has even returned the unsubscriber.
        cb({ scan: scanResult([item('cached')]), loading: false })
        return () => {
          unsubscribed += 1
        }
      },
    })
    const items = await reader.list('ws-1')
    assert.deepEqual(
      items.map((entry) => entry.id),
      ['cached'],
    )
    await settleMicrotasks()
    assert.equal(unsubscribed, 1, 'the synchronous-snapshot path still unsubscribes exactly once')
  }

  async function testWatchEmitsOnlySettledScansAndUnsubscribes(): Promise<void> {
    const emitters: Array<(snapshot: BacklogScanSnapshot) => void> = []
    let unsubscribed = 0
    const reader = createBacklogReader({
      resolveFolderPath: async () => FOLDER,
      subscribe: (_folderPath, cb) => {
        emitters.push(cb)
        cb({ scan: null, loading: true })
        return () => {
          unsubscribed += 1
        }
      },
    })

    const seen: string[][] = []
    const off = reader.watch('ws-1', (items) => seen.push(items.map((entry) => entry.id)))
    // Folder resolution is async; let the subscription attach.
    await settleMicrotasks()
    assert.equal(emitters.length, 1, 'watch subscribes once the folder resolves')
    assert.deepEqual(seen, [], 'a loading snapshot is never emitted (no half-scans)')

    emitters[0]!({ scan: scanResult([item('a')]), loading: false })
    emitters[0]!({ scan: scanResult([item('a')]), loading: true })
    emitters[0]!({ scan: scanResult([item('a'), item('b')]), loading: false })
    assert.deepEqual(seen, [['a'], ['a', 'b']], 'each settled scan emits; loading ticks are skipped')

    off()
    assert.equal(unsubscribed, 1, 'unsubscribe tears the shared subscription down')
  }

  async function testWatchDisposedBeforeFolderResolves(): Promise<void> {
    let subscribes = 0
    const reader = createBacklogReader({
      resolveFolderPath: () => new Promise((resolve) => setTimeout(() => resolve(FOLDER), 5)),
      subscribe: () => {
        subscribes += 1
        return () => {}
      },
    })
    const off = reader.watch('ws-1', () => {})
    off()
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(subscribes, 0, 'an immediately-disposed watch never attaches a subscription')
  }

  async function testResultsAreCopiesNotTheLiveArray(): Promise<void> {
    const sourceItems = [item('a')]
    const source = scanResult(sourceItems)
    const reader = createBacklogReader({
      resolveFolderPath: async () => FOLDER,
      subscribe: (_folderPath, cb) => {
        cb({ scan: source, loading: false })
        return () => {}
      },
    })
    const listed = await reader.list('ws-1')
    listed.push(item('injected'))
    ;(listed[0] as { status: string }).status = 'archived'
    assert.equal(sourceItems.length, 1, 'mutating the listed array never touches the shared scan')
    assert.equal((sourceItems[0] as { status: string }).status, 'ready', 'item fields are copies too')

    let watchedItems: BacklogItem[] = []
    const off = reader.watch('ws-1', (items) => {
      watchedItems = items
    })
    await settleMicrotasks()
    watchedItems.splice(0)
    assert.equal(sourceItems.length, 1, 'watch deliveries are copies as well')
    off()
  }

  async function testErrorScansAreNotEmptyBacklogs(): Promise<void> {
    const errorScan = {
      state: 'error',
      items: [],
      errors: [{ relativePath: 'backlog/', message: 'EACCES: permission denied' }],
    } as unknown as BacklogScanResult
    const emitters: Array<(snapshot: BacklogScanSnapshot) => void> = []
    const reader = createBacklogReader({
      resolveFolderPath: async () => FOLDER,
      subscribe: (_folderPath, cb) => {
        emitters.push(cb)
        cb({ scan: errorScan, loading: false })
        return () => {}
      },
    })
    await assert.rejects(
      () => reader.list('ws-1'),
      /could not be read.*EACCES/,
      'an unreadable backlog rejects instead of resolving as empty',
    )

    const seen: number[] = []
    const off = reader.watch('ws-1', (items) => seen.push(items.length))
    await settleMicrotasks()
    assert.deepEqual(seen, [], 'watch never delivers a failed scan as "no items"')
    emitters[1]!({ scan: scanResult([item('recovered')]), loading: false })
    assert.deepEqual(seen, [1], 'a later healthy scan flows through')
    off()
  }

  // End-to-end over the real shared-scan layer (fake scan runner): the reader and
  // a sibling consumer share ONE subscription-map entry per project root — the
  // no-second-pipeline guarantee.
  async function testReaderSharesTheSingleScanPipeline(): Promise<void> {
    __resetBacklogScanSubscriptionsForTests()
    let scans = 0
    __setBacklogScanRunnerForTests(async () => {
      scans += 1
      return scanResult([item('shared')])
    })

    try {
      const reader = createBacklogReader({
        resolveFolderPath: async () => FOLDER,
        subscribe: subscribeBacklogScan,
      })

      // A sibling consumer (standing in for the Backlog panel) already on the folder.
      const offSibling = subscribeBacklogScan(FOLDER, () => {})
      await __flushBacklogScanForTests(FOLDER)
      assert.equal(__backlogScanSubscriptionCountForTests(), 1)
      assert.equal(scans, 1)

      const items = await reader.list('ws-1')
      assert.deepEqual(
        items.map((entry) => entry.id),
        ['shared'],
      )
      assert.equal(__backlogScanSubscriptionCountForTests(), 1, 'list rides the existing entry — no second pipeline')
      assert.equal(scans, 1, 'the cached snapshot serves list without a re-scan')

      const seen: string[][] = []
      const offWatch = reader.watch('ws-1', (entries) => seen.push(entries.map((entry) => entry.id)))
      await settleMicrotasks()
      assert.deepEqual(seen, [['shared']], 'watch fires immediately with the current snapshot')
      assert.equal(__backlogScanSubscriptionCountForTests(), 1)

      offWatch()
      offSibling()
      await settleMicrotasks()
      assert.equal(__backlogScanSubscriptionCountForTests(), 0, 'last unsubscribe tears the shared entry down')
    } finally {
      __resetBacklogScanSubscriptionsForTests()
    }
  }

  async function main(): Promise<void> {
    await testListResolvesFirstSettledSnapshot()
    await testListResolvesImmediatelyFromCachedSnapshot()
    await testWatchEmitsOnlySettledScansAndUnsubscribes()
    await testWatchDisposedBeforeFolderResolves()
    await testResultsAreCopiesNotTheLiveArray()
    await testErrorScansAreNotEmptyBacklogs()
    await testReaderSharesTheSingleScanPipeline()

    console.log('backlog reader tests passed')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

  await suiteRun
})
