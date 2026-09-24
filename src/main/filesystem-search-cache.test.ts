import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { FileWatchEvent } from '../shared/ipc/filesystem'
import { createFileListCache, filterFileList } from './filesystem-search'
import type { WatchHub } from './workspace-watch-hub'

function fakeHub() {
  const listeners: Array<(event: FileWatchEvent) => void> = []
  let closed = 0
  const hub: WatchHub = {
    subscribe: (_root, listener) => {
      listeners.push(listener)
      return { close: () => (closed += 1) }
    },
    watcherCount: () => listeners.length - closed,
  }
  return {
    hub,
    emit: (event: FileWatchEvent) => listeners.forEach((listener) => listener(event)),
    closed: () => closed,
  }
}

test('quick-open walks the tree once and re-walks only when its shape changes', async () => {
  const { hub, emit } = fakeHub()
  let walks = 0
  let clock = 0
  const cache = createFileListCache({
    hub: () => hub,
    now: () => clock,
    listFiles: async () => {
      walks += 1
      return ['src/app.ts', 'src/app.test.ts', 'README.md']
    },
  })

  for (const _keystroke of 'app.ts') await cache.list('/Users/dev/app')
  assert.equal(walks, 1, 'one walk for a whole typed query')

  emit({ eventType: 'change', path: 'src/app.ts', paths: ['src/app.ts'] })
  await cache.list('/Users/dev/app')
  assert.equal(walks, 1, 'a content edit does not change the list')

  emit({ eventType: 'rename', path: 'src/new.ts', paths: ['src/new.ts'] })
  await cache.list('/Users/dev/app')
  assert.equal(walks, 2, 'a created file does')

  emit({ eventType: 'change', path: '.gitignore', paths: ['.gitignore'] })
  await cache.list('/Users/dev/app')
  assert.equal(walks, 3, 'so does an ignore-file edit, which changes what rg lists')

  emit({ eventType: 'change', path: null, paths: [], overflow: true })
  await cache.list('/Users/dev/app')
  assert.equal(walks, 4, 'an unlisted burst is assumed to reshape')

  clock += 10 * 60_000
  await cache.list('/Users/dev/app')
  assert.equal(walks, 5, 'the age bound is a backstop for a missed event')
  cache.clear()
})

test('concurrent queries share one walk, and a walk overtaken by a change is not kept', async () => {
  const { hub, emit } = fakeHub()
  let walks = 0
  let release: (() => void) | null = null
  const cache = createFileListCache({
    hub: () => hub,
    listFiles: () =>
      new Promise((resolve) => {
        walks += 1
        release = () => resolve(['a.ts'])
      }),
  })
  const first = cache.list('/Users/dev/app')
  const second = cache.list('/Users/dev/app')
  emit({ eventType: 'rename', path: 'b.ts', paths: ['b.ts'] })
  release!()
  assert.deepEqual(await first, ['a.ts'])
  assert.deepEqual(await second, ['a.ts'])
  assert.equal(walks, 1)
  const third = cache.list('/Users/dev/app')
  release!()
  await third
  assert.equal(walks, 2, 'the list that raced a rename was answered from but not held')
  cache.clear()
})

test('the in-memory filter matches and ranks like the walk did', () => {
  const result = filterFileList('/Users/dev/app', ['src/deep/app.ts', 'app.ts', 'lib/other.ts'], 'APP', 10)
  assert.deepEqual(
    result.results.map((entry) => entry.name),
    ['app.ts', 'app.ts'],
  )
  assert.equal(result.results[0].path, '/Users/dev/app/app.ts', 'the shorter path ranks first')
  const limited = filterFileList('/Users/dev/app', ['a1', 'a2', 'a3'], 'a', 2)
  assert.equal(limited.results.length, 2)
  assert.equal(limited.truncated, true)
})
