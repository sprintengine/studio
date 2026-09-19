import assert from 'node:assert/strict'

import type { BacklogScanResult } from '../utils/backlog'
import {
  __backlogScanSubscriptionCountForTests as subscriptionCount,
  __refreshSharedBacklogScanForTests as refreshShared,
  __resetBacklogScanSubscriptionsForTests as reset,
  __setBacklogScanRunnerForTests as setRunner,
  __subscribeBacklogScanForTests as subscribe,
  __flushBacklogScanForTests as flush,
} from './useSharedBacklogScan'
import { test } from 'vitest'

test('useSharedBacklogScan', async () => {
  const tests: Array<{ name: string; body: () => Promise<void> }> = []
  function run(name: string, body: () => Promise<void>): void {
    tests.push({ name, body })
  }

  // A controllable fake scan runner: counts calls per folder and returns a fresh
  // ready-result each time so callers can tell updates apart by identity/marker.
  function makeRunner() {
    const calls: Record<string, number> = {}
    const runner = async (folderPath: string): Promise<BacklogScanResult> => {
      calls[folderPath] = (calls[folderPath] ?? 0) + 1
      return {
        state: 'ready',
        items: [
          {
            id: `${folderPath}#${calls[folderPath]}`,
            objectId: 'obj',
            path: `${folderPath}/backlog/a.md`,
            relativePath: 'backlog/a.md',
            title: `scan ${calls[folderPath]}`,
            status: 'idea',
            isEpic: false,
            metadata: {},
            links: [],
            excerpt: '',
            modifiedAt: 0,
            createdAtMs: 0,
            size: 0,
            sourceContent: '',
          },
        ],
        errors: [],
      }
    }
    return { runner, calls }
  }

  type Snap = { scan: BacklogScanResult | null; loading: boolean }
  function recorder() {
    const snaps: Snap[] = []
    const cb = (snapshot: Snap) => snaps.push(snapshot)
    return {
      cb,
      get last(): Snap | undefined {
        return snaps.at(-1)
      },
    }
  }

  run('a folder is scanned once no matter how many panels subscribe', async () => {
    reset()
    const { runner, calls } = makeRunner()
    setRunner(runner)

    const a = recorder()
    const b = recorder()
    const unsubA = subscribe('/project', a.cb)
    const unsubB = subscribe('/project', b.cb)
    await flush('/project')

    assert.equal(calls['/project'], 1, 'two subscribers triggered exactly one scan')
    assert.equal(subscriptionCount(), 1, 'one shared entry for the folder')
    assert.equal(a.last?.scan?.items[0]?.title, 'scan 1')
    assert.equal(b.last?.scan?.items[0]?.title, 'scan 1', 'both subscribers see the shared result')
    assert.equal(a.last?.scan, b.last?.scan, 'both share the identical result reference')

    unsubA()
    unsubB()
  })

  run('same folder shares regardless of path case (workspace folder key)', async () => {
    reset()
    const { runner, calls } = makeRunner()
    setRunner(runner)

    const unsub1 = subscribe('/Project/Repo', recorder().cb)
    const unsub2 = subscribe('/project/repo', recorder().cb)
    await flush('/Project/Repo')

    assert.equal(subscriptionCount(), 1, 'case-different paths collapse to one project entry')
    // Both paths normalize to the same key, so only the first scan ran.
    const total = Object.values(calls).reduce((sum, n) => sum + n, 0)
    assert.equal(total, 1)

    unsub1()
    unsub2()
  })

  run('a refresh from one subscriber updates every subscriber on the folder', async () => {
    reset()
    const { runner, calls } = makeRunner()
    setRunner(runner)

    const a = recorder()
    const b = recorder()
    const unsubA = subscribe('/project', a.cb)
    const unsubB = subscribe('/project', b.cb)
    await flush('/project')

    await refreshShared('/project')

    assert.equal(calls['/project'], 2, 'refresh ran a second scan')
    assert.equal(a.last?.scan?.items[0]?.title, 'scan 2')
    assert.equal(b.last?.scan?.items[0]?.title, 'scan 2', 'the non-initiating subscriber updated too')

    unsubA()
    unsubB()
  })

  run('folder keys are isolated: refreshing one does not rescan another', async () => {
    reset()
    const { runner, calls } = makeRunner()
    setRunner(runner)

    const a = recorder()
    const b = recorder()
    const unsubA = subscribe('/project-a', a.cb)
    const unsubB = subscribe('/project-b', b.cb)
    await flush('/project-a')
    await flush('/project-b')
    assert.equal(calls['/project-a'], 1)
    assert.equal(calls['/project-b'], 1)

    await refreshShared('/project-a')

    assert.equal(calls['/project-a'], 2, 'project A rescanned')
    assert.equal(calls['/project-b'], 1, 'project B untouched')
    assert.equal(b.last?.scan?.items[0]?.title, 'scan 1', 'project B subscriber not disturbed')

    unsubA()
    unsubB()
  })

  run('the shared entry is disposed only when the last subscriber unsubscribes', async () => {
    reset()
    setRunner(makeRunner().runner)

    const unsub1 = subscribe('/project', recorder().cb)
    const unsub2 = subscribe('/project', recorder().cb)
    await flush('/project')
    assert.equal(subscriptionCount(), 1)

    unsub1()
    assert.equal(subscriptionCount(), 1, 'still alive while one subscriber remains')
    unsub2()
    assert.equal(subscriptionCount(), 0, 'disposed when the last subscriber leaves')
  })

  run('a scan that finishes after teardown does not repopulate a dead entry', async () => {
    reset()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setRunner(async (): Promise<BacklogScanResult> => {
      await gate
      return { state: 'ready', items: [], errors: [] }
    })

    const unsub = subscribe('/project', recorder().cb)
    assert.equal(subscriptionCount(), 1)
    unsub() // unsubscribe while the scan is still gated/in flight
    assert.equal(subscriptionCount(), 0, 'entry removed on last unsubscribe')

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(subscriptionCount(), 0, 'the late scan did not resurrect the entry')
  })

  run('watcher: starts per project, refreshes on event, disposes on last unsubscribe', async () => {
    reset()
    let watchedPath: string | null = null
    let watcherRegistered = false
    let emit = (): void => {
      throw new Error('expected backlog watcher callback to be registered')
    }
    let stopCalls = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        watchPath: async (path: string, cb: () => void) => {
          watchedPath = path
          watcherRegistered = true
          emit = cb
          return async () => {
            stopCalls += 1
          }
        },
      },
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    }

    try {
      const { runner, calls } = makeRunner()
      setRunner(runner)

      const unsub = subscribe('/project', recorder().cb)
      await flush('/project')
      await new Promise((resolve) => setTimeout(resolve, 0)) // let watchPath() resolve

      assert.equal(watchedPath, '/project/backlog', 'watches the project backlog/ directory')
      assert.equal(calls['/project'], 1)

      assert.equal(watcherRegistered, true)
      emit() // an external file change
      await new Promise((resolve) => setTimeout(resolve, 400)) // past the debounce
      await flush('/project')
      assert.equal(calls['/project'], 2, 'a watch event triggered a shared re-scan')

      unsub()
      assert.equal(stopCalls, 1, 'the watcher is disposed on last unsubscribe')
      assert.equal(subscriptionCount(), 0)
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })

  async function main(): Promise<void> {
    for (const test of tests) {
      try {
        await test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        console.error(`not ok - ${test.name}`)
        throw error
      }
    }
    console.log('useSharedBacklogScan.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
