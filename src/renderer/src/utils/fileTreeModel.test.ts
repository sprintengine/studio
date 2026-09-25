import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { FileWatchEvent } from '../../../shared/ipc/filesystem'
import {
  FILE_TREE_WATCH_DEBOUNCE_MS,
  acquireFileTreeModel,
  liveFileTreeModelCount,
  type FileTreeModelApi,
} from './fileTreeModel'

// The shared per-root tree model: what it reads, when, and how many watches it
// holds. These are the promises the Files pane and the editor window's tree
// both lean on — a reveal that read the whole tree, or a second watcher per
// view, would be invisible in a screenshot and expensive on a big checkout.

const ROOT = '/Users/dev/app'

// A small disk: every folder's listing, by path.
const DISK: Record<string, { name: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: 'src', isDir: true },
    { name: 'docs', isDir: true },
    { name: 'package.json', isDir: false },
  ],
  [`${ROOT}/src`]: [
    { name: 'main', isDir: true },
    { name: 'renderer', isDir: true },
  ],
  [`${ROOT}/src/main`]: [{ name: 'index.ts', isDir: false }],
  [`${ROOT}/src/renderer`]: [{ name: 'App.tsx', isDir: false }],
  [`${ROOT}/docs`]: [{ name: 'guide.md', isDir: false }],
}

function fakeApi() {
  const reads: string[] = []
  const watches: string[] = []
  const stopped: string[] = []
  const listeners: Array<(event: FileWatchEvent) => void> = []
  const api: FileTreeModelApi = {
    readdir: async (path) => {
      reads.push(path)
      const listing = DISK[path]
      if (!listing) throw new Error(`ENOENT: ${path}`)
      return listing
    },
    watchPath: async (path, cb) => {
      watches.push(path)
      listeners.push(cb)
      return async () => {
        stopped.push(path)
      }
    },
    checkIgnored: async () => [],
  }
  return { api, reads, watches, stopped, emit: (event: FileWatchEvent) => listeners.forEach((cb) => cb(event)) }
}

afterEach(() => {
  vi.useRealTimers()
})

test('reveal reads only the folders between the root and the file, and only once', async () => {
  const fake = fakeApi()
  const { model, release } = acquireFileTreeModel(ROOT, fake.api)

  const ancestors = await model.reveal(`${ROOT}/src/main/index.ts`).done
  assert.deepEqual(ancestors, [`${ROOT}/src`, `${ROOT}/src/main`], 'the ancestors, outermost first')
  assert.deepEqual(
    fake.reads,
    [ROOT, `${ROOT}/src`, `${ROOT}/src/main`],
    'the root and the two ancestors — never a sibling (docs, renderer) and never a scan',
  )

  fake.reads.length = 0
  await model.reveal(`${ROOT}/src/renderer/App.tsx`).done
  assert.deepEqual(fake.reads, [`${ROOT}/src/renderer`], 'folders already listed are not read again')

  fake.reads.length = 0
  assert.equal(
    await model.reveal('/Users/dev/elsewhere/fix.patch').done,
    null,
    'a file outside the root reveals nothing',
  )
  assert.deepEqual(fake.reads, [], 'and reads nothing')

  release()
})

test('a cancelled reveal stops at the next folder', async () => {
  const fake = fakeApi()
  const { model, release } = acquireFileTreeModel(ROOT, fake.api)
  const handle = model.reveal(`${ROOT}/src/main/index.ts`)
  handle.cancel()
  assert.equal(await handle.done, null)
  assert.ok(!fake.reads.includes(`${ROOT}/src/main`), 'the deepest folder was never read')
  release()
})

test('one watch per root, shared by every holder, stopped when the last lets go', async () => {
  const fake = fakeApi()
  const before = liveFileTreeModelCount()
  const first = acquireFileTreeModel(ROOT, fake.api)
  const second = acquireFileTreeModel(`${ROOT}/`, fake.api)
  assert.equal(first.model, second.model, 'two views of one root hold one model')
  await Promise.resolve()
  assert.deepEqual(fake.watches, [ROOT], 'and one watch')
  assert.equal(liveFileTreeModelCount(), before + 1)

  first.release()
  first.release() // idempotent: a double release must not drop the other holder
  await Promise.resolve()
  assert.deepEqual(fake.stopped, [], 'the watch outlives one holder')

  second.release()
  await Promise.resolve()
  assert.deepEqual(fake.stopped, [ROOT], 'and stops with the last')
  assert.equal(liveFileTreeModelCount(), before, 'the model is gone, cache and all')

  const again = acquireFileTreeModel(ROOT, fake.api)
  assert.notEqual(again.model, first.model, 'a later holder starts fresh')
  again.release()
})

test('a watch event re-reads only the listed folders it touched, once per burst', async () => {
  vi.useFakeTimers()
  const fake = fakeApi()
  const { model, release } = acquireFileTreeModel(ROOT, fake.api)
  await vi.advanceTimersByTimeAsync(0)
  await model.reveal(`${ROOT}/src/main/index.ts`).done
  fake.reads.length = 0

  fake.emit({ eventType: 'change', path: 'src/main/index.ts', paths: ['src/main/index.ts'] })
  fake.emit({ eventType: 'rename', path: 'src/main/new.ts', paths: ['src/main/new.ts'] })
  fake.emit({ eventType: 'rename', path: 'docs/guide.md', paths: ['docs/guide.md'] })
  fake.emit({ eventType: 'change', path: 'node_modules/x/index.js', paths: ['node_modules/x/index.js'] })
  assert.deepEqual(fake.reads, [], 'nothing is read inside the debounce')

  await vi.advanceTimersByTimeAsync(FILE_TREE_WATCH_DEBOUNCE_MS)
  assert.deepEqual(
    fake.reads,
    [`${ROOT}/src/main`],
    'one read of the touched folder that is listed; docs was never opened, and dependency churn is skipped',
  )

  fake.reads.length = 0
  fake.emit({ eventType: 'change', path: null, paths: [], overflow: true })
  await vi.advanceTimersByTimeAsync(FILE_TREE_WATCH_DEBOUNCE_MS)
  assert.deepEqual(
    [...fake.reads].sort(),
    [ROOT, `${ROOT}/src`, `${ROOT}/src/main`].sort(),
    'an event that names nothing re-reads what is held — and only that',
  )
  release()
})

test('a folder that can no longer be read is dropped with everything under it', async () => {
  const fake = fakeApi()
  const { model, release } = acquireFileTreeModel(ROOT, fake.api)
  await model.reveal(`${ROOT}/src/main/index.ts`).done
  const saved = DISK[`${ROOT}/src`]
  delete DISK[`${ROOT}/src`]
  try {
    await model.refresh([`${ROOT}/src`])
    assert.equal(model.isLoaded(`${ROOT}/src`), false)
    assert.equal(model.isLoaded(`${ROOT}/src/main`), false, 'its children go with it')
    assert.equal(model.isLoaded(ROOT), true, 'the root stays')
  } finally {
    DISK[`${ROOT}/src`] = saved
    release()
  }
})

test('dropping one folder does not throw away a sibling read that was already on the wire', async () => {
  const fake = fakeApi()
  const { model, release } = acquireFileTreeModel(ROOT, fake.api)
  await model.reveal(`${ROOT}/src/main/index.ts`).done
  const saved = DISK[`${ROOT}/src/main`]
  delete DISK[`${ROOT}/src/main`]
  DISK[ROOT] = [...DISK[ROOT], { name: 'NEW.md', isDir: false }]
  try {
    // The watcher's case: the parent and the vanished child re-read together.
    await model.refresh([ROOT, `${ROOT}/src/main`])
    assert.equal(model.isLoaded(`${ROOT}/src/main`), false, 'the vanished folder is dropped')
    assert.ok(
      model.getSnapshot().rootEntries?.some((entry) => entry.name === 'NEW.md'),
      "and the parent's fresh listing still lands",
    )
  } finally {
    DISK[`${ROOT}/src/main`] = saved
    DISK[ROOT] = DISK[ROOT].filter((entry) => entry.name !== 'NEW.md')
    release()
  }
})

test('two spellings of one root share one model; a different case is a different root', () => {
  const fake = fakeApi()
  const a = acquireFileTreeModel(ROOT, fake.api)
  const b = acquireFileTreeModel(`${ROOT}/`, fake.api)
  const c = acquireFileTreeModel(ROOT.toUpperCase(), fake.api)
  assert.equal(a.model, b.model)
  assert.notEqual(a.model, c.model)
  a.release()
  b.release()
  c.release()
})
