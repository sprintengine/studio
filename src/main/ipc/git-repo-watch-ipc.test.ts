import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

import { createWindowRetains, type RetainingSender } from './git-repo-watch-ipc'

function fakeWatch() {
  const held = new Map<string, number>()
  return {
    held,
    retain: async (raw: string) => {
      const path = raw.replace(/\/+$/, '')
      held.set(path, (held.get(path) ?? 0) + 1)
      return path
    },
    release: (path: string) => {
      const count = (held.get(path) ?? 0) - 1
      if (count > 0) held.set(path, count)
      else held.delete(path)
    },
  }
}

function fakeSender(id: number): RetainingSender & { emit: (event: string) => void } {
  const emitter = new EventEmitter()
  return {
    id,
    once: (event, listener) => emitter.once(event, listener),
    on: (event, listener) => emitter.on(event, listener),
    emit: (event) => emitter.emit(event),
  }
}

test('a reload gives back every checkout the page retained, and the new page retains afresh', async () => {
  const watch = fakeWatch()
  const retains = createWindowRetains(watch)
  const window = fakeSender(7)
  await retains.retain(window, '/Users/dev/app')
  await retains.retain(window, '/Users/dev/app/')
  await retains.retain(window, '/Users/dev/wt-a')
  assert.deepEqual(
    [...watch.held],
    [
      ['/Users/dev/app', 2],
      ['/Users/dev/wt-a', 1],
    ],
  )

  window.emit('did-navigate')
  assert.equal(watch.held.size, 0, 'the old page held nothing after the reload')

  // The reloaded page, on the same webContents.
  await retains.retain(window, '/Users/dev/app')
  assert.deepEqual([...watch.held], [['/Users/dev/app', 1]])
  assert.equal(retains.retainedBy(7, '/Users/dev/app'), 1)

  // Reloading again does not double-release through a second listener.
  window.emit('did-navigate')
  window.emit('did-navigate')
  assert.equal(watch.held.size, 0)
})

test('closing a window gives back what it held; another window keeps its own', async () => {
  const watch = fakeWatch()
  const retains = createWindowRetains(watch)
  const first = fakeSender(1)
  const second = fakeSender(2)
  await retains.retain(first, '/Users/dev/app')
  await retains.retain(second, '/Users/dev/app')
  first.emit('destroyed')
  assert.deepEqual([...watch.held], [['/Users/dev/app', 1]])
  retains.release(2, '/Users/dev/app')
  retains.release(2, '/Users/dev/app')
  assert.equal(watch.held.size, 0, 'an extra release is ignored')
})
