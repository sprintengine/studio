import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { FSWatcher, WatchListener } from 'node:fs'
import { test } from 'vitest'

import type { FileWatchEvent } from '../shared/ipc/filesystem'
import { WATCH_BATCH_PATH_LIMIT, createWatchHub, isIgnoredWatchPath } from './workspace-watch-hub'

type FakeWatcher = { root: string; recursive: boolean; emit: WatchListener<string>; closed: boolean }

function harness(tracked: string[] = []) {
  const watchers: FakeWatcher[] = []
  const timers: Array<{ callback: () => void; cleared: boolean }> = []
  const asked: string[] = []
  const hub = createWatchHub({
    platform: 'darwin',
    trackedBuildPaths: async (root) => {
      asked.push(root)
      return new Set(tracked)
    },
    watch: (root, options, listener) => {
      const record: FakeWatcher = { root, recursive: options.recursive, emit: listener, closed: false }
      watchers.push(record)
      const emitter = new EventEmitter() as unknown as FSWatcher
      ;(emitter as unknown as { close: () => void }).close = () => {
        record.closed = true
      }
      return emitter
    },
    setTimer: (callback) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer as unknown as NodeJS.Timeout
    },
    clearTimer: (timer) => {
      ;(timer as unknown as { cleared: boolean }).cleared = true
    },
  })
  const flushTimers = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback()
  }
  return { hub, watchers, timers, flushTimers, asked }
}

/** Lets a pending `trackedBuildPaths` answer land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('one OS watcher per root, however many callers watch it', () => {
  const { hub, watchers } = harness()
  const first = hub.subscribe('/Users/dev/app', () => {})
  const second = hub.subscribe('/Users/dev/app/', () => {})
  assert.equal(watchers.length, 1, 'a trailing slash is the same root')
  assert.equal(watchers[0].recursive, true)
  first.close()
  assert.equal(watchers[0].closed, false, 'still watched by the second caller')
  second.close()
  assert.equal(watchers[0].closed, true, 'the last caller out closes it')
  assert.equal(hub.watcherCount(), 0)
})

test('a burst is delivered as the set of paths that changed, with churn filtered in main', async () => {
  const { hub, watchers, timers, flushTimers } = harness()
  const events: FileWatchEvent[] = []
  hub.subscribe('/Users/dev/app', (event) => events.push(event))

  const emit = watchers[0].emit
  // The first event in a build directory asks git what it tracks there; until
  // the answer lands it is delivered.
  emit('change', 'dist/first.js')
  await settle()
  flushTimers()
  assert.deepEqual(events.splice(0)[0]?.paths, ['dist/first.js'])
  emit('change', 'node_modules/left-pad/index.js')
  emit('change', 'src/app.ts')
  emit('rename', '.git/index.lock')
  emit('change', 'src/app.ts')
  emit('change', 'dist/bundle.js')
  emit('change', '.sprintengine/conversations/c1.jsonl')
  assert.equal(timers.length, 1, 'one timer per window, not a reset per raw event')
  flushTimers()

  assert.equal(events.length, 1)
  assert.deepEqual(events[0].paths, ['src/app.ts'], 'the real edit survives the burst it arrived in')
  assert.equal(events[0].path, 'src/app.ts')
  assert.equal(events[0].eventType, 'change', 'the only rename was filtered out')

  emit('change', 'node_modules/x/y.js')
  emit('change', 'build/out.o')
  assert.equal(timers.length, 0, 'pure churn never schedules anything')
})

test('a caller that asks for everything still shares the watcher and hears the ignored paths', () => {
  const { hub, watchers, flushTimers } = harness()
  const plain: FileWatchEvent[] = []
  const everything: FileWatchEvent[] = []
  hub.subscribe('/Users/dev/app', (event) => plain.push(event))
  hub.subscribe('/Users/dev/app', (event) => everything.push(event), { includeIgnored: true })
  assert.equal(watchers.length, 1)

  watchers[0].emit('change', '.sprintengine/modules/state.json')
  flushTimers()
  assert.equal(plain.length, 0)
  assert.deepEqual(everything[0]?.paths, ['.sprintengine/modules/state.json'])
})

test('an event with no filename, or too many, is delivered as "re-read" rather than dropped', () => {
  const { hub, watchers, flushTimers } = harness()
  const events: FileWatchEvent[] = []
  hub.subscribe('/Users/dev/app', (event) => events.push(event))

  watchers[0].emit('change', null as unknown as string)
  flushTimers()
  assert.equal(events[0].overflow, true)
  assert.deepEqual(events[0].paths, [])

  for (let index = 0; index <= WATCH_BATCH_PATH_LIMIT; index += 1) watchers[0].emit('change', `src/file-${index}.ts`)
  flushTimers()
  assert.equal(events[1].overflow, true, 'past the limit the burst reads as "many"')
})

test('the ignore rules', () => {
  assert.equal(isIgnoredWatchPath('node_modules/a/b.js'), true)
  assert.equal(isIgnoredWatchPath('packages/web/node_modules/a.js'), true)
  assert.equal(isIgnoredWatchPath('.git/refs/heads/main'), true)
  assert.equal(isIgnoredWatchPath('.sprintengine/x.json'), true)
  assert.equal(isIgnoredWatchPath('dist/index.js'), true)
  assert.equal(isIgnoredWatchPath('out'), false, 'the directory itself appearing is still news to the tree')
  assert.equal(isIgnoredWatchPath('src/build/index.ts'), false, 'a nested build/ may be source')
  assert.equal(isIgnoredWatchPath('src/app.ts'), false)
  assert.equal(isIgnoredWatchPath('.gitignore'), false)
  const tracked = new Set(['build/entitlements.mac.plist', 'build/icons', 'build/icons/app.icns'])
  const isTracked = (path: string) => tracked.has(path)
  assert.equal(isIgnoredWatchPath('build/entitlements.mac.plist', isTracked), false, 'a tracked file is never dropped')
  assert.equal(isIgnoredWatchPath('build/icons', isTracked), false, 'nor a folder holding one')
  assert.equal(isIgnoredWatchPath('build\\entitlements.mac.plist', isTracked), false, 'in either slash')
  assert.equal(isIgnoredWatchPath('build/out.o', isTracked), true, 'untracked output beside them still is')
})

test('a tracked file in a top-level build directory reaches the subscribers; output beside it does not', async () => {
  const { hub, watchers, flushTimers, asked } = harness(['build/entitlements.mac.plist'])
  const events: FileWatchEvent[] = []
  hub.subscribe('/Users/dev/app', (event) => events.push(event))
  const emit = watchers[0].emit

  emit('change', 'build/entitlements.mac.plist')
  await settle()
  flushTimers()
  assert.deepEqual(events.splice(0)[0]?.paths, ['build/entitlements.mac.plist'])

  emit('change', 'build/entitlements.mac.plist')
  emit('change', 'build/electron/out.js')
  emit('change', 'coverage/lcov.info')
  flushTimers()
  assert.deepEqual(events.splice(0)[0]?.paths, ['build/entitlements.mac.plist'])
  assert.equal(asked.length, 1, 'one git question per root, not per event')

  // The index moving (a `git add` in build/) asks again, once.
  emit('change', '.git/index')
  emit('change', 'build/new.plist')
  emit('change', 'build/other.plist')
  await settle()
  assert.equal(asked.length, 2)
})
