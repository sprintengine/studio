import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { createFakeIpcMain } from './ipc-main-fake.test-helper'
import { createMainKernel } from './main-host'
import { createModuleAppStateMirror, normalizeModuleAppStateBag } from './module-app-state-mirror'

// Main's copy of module app state: what a module's Settings section wrote in a
// window, readable from `entry.main` with no window open.

let dir = ''
let filePath = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'module-app-state-'))
  filePath = join(dir, 'module-app-state.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('only module namespaces holding objects are kept', () => {
  assert.deepEqual(
    normalizeModuleAppStateBag({
      'module:insights': { time: '09:00' },
      'module:': { lost: true },
      theme: { not: 'a module' },
      'module:bad': ['array'],
    }),
    { 'module:insights': { time: '09:00' } },
  )
  assert.deepEqual(normalizeModuleAppStateBag(null), {})
})

test('a push is readable per module and persisted for the next process', () => {
  const mirror = createModuleAppStateMirror({ filePath, watchFile: false })
  assert.deepEqual(mirror.get('insights'), {})
  mirror.set({ 'module:insights': { time: '09:00', days: [1, 2, 3] }, 'module:pr-radar': { pollMinutes: 5 } })
  assert.deepEqual(mirror.get('insights'), { time: '09:00', days: [1, 2, 3] })
  assert.deepEqual(mirror.get('pr-radar'), { pollMinutes: 5 })
  const restarted = createModuleAppStateMirror({ filePath, watchFile: false })
  assert.deepEqual(restarted.get('pr-radar'), { pollMinutes: 5 })
})

test("a watcher hears only its own module's namespace, and only when it moved", () => {
  const mirror = createModuleAppStateMirror({ filePath, watchFile: false })
  mirror.set({ 'module:insights': { time: '09:00' } })
  const heard: unknown[] = []
  const stop = mirror.subscribe('insights', (values) => heard.push(values))
  mirror.set({ 'module:insights': { time: '09:00' }, 'module:pr-radar': { pollMinutes: 5 } })
  assert.deepEqual(heard, [], "another module's change, and an unchanged push, are not heard")
  mirror.set({ 'module:insights': { time: '10:30' }, 'module:pr-radar': { pollMinutes: 5 } })
  assert.deepEqual(heard, [{ time: '10:30' }])
  mirror.set({ 'module:pr-radar': { pollMinutes: 5 } })
  assert.deepEqual(heard, [{ time: '10:30' }, {}], 'a cleared namespace is heard as empty')
  stop()
  mirror.set({ 'module:insights': { time: '11:00' } })
  assert.equal(heard.length, 2)
})

test('an unchanged push does not rewrite the file', () => {
  const mirror = createModuleAppStateMirror({ filePath, watchFile: false })
  mirror.set({ 'module:insights': { time: '09:00' } })
  writeFileSync(filePath, JSON.stringify({ 'module:insights': { time: '09:00' } }) + '\n// marker')
  mirror.set({ 'module:insights': { time: '09:00' } })
  assert.match(readFileSync(filePath, 'utf8'), /marker/)
})

test('a push written by another process is heard through the file', async () => {
  const reader = createModuleAppStateMirror({ filePath, watchIntervalMs: 20 })
  const writer = createModuleAppStateMirror({ filePath, watchFile: false })
  const heard: unknown[] = []
  const stop = reader.subscribe('insights', (values) => heard.push(values))
  try {
    writer.set({ 'module:insights': { time: '07:45' } })
    await waitFor(() => heard.length > 0)
    assert.deepEqual(heard[0], { time: '07:45' })
    assert.deepEqual(reader.get('insights'), { time: '07:45' })
  } finally {
    stop()
    reader.dispose()
  }
})

test('MainHost reads and watches its own namespace through the mirror', () => {
  const kernel = createMainKernel(createFakeIpcMain().ipcMain)
  assert.equal(kernel.hostFor('insights').getModuleAppState('time'), undefined, 'no mirror yet reads as unset')
  const mirror = createModuleAppStateMirror({ filePath, watchFile: false })
  kernel.hostFor('agent-runtime').provideService({ key: 'core.module-app-state' }, () => mirror)
  mirror.set({ 'module:insights': { time: '09:00' }, 'module:pr-radar': { secretish: 'other' } })

  const host = kernel.hostFor('insights')
  assert.equal(host.getModuleAppState<string>('time'), '09:00')
  assert.equal(host.getModuleAppState('secretish'), undefined, "another module's keys are out of reach")

  const heard: unknown[] = []
  const stop = host.watchModuleAppState((values) => heard.push(values))
  mirror.set({ 'module:insights': { time: '08:00' } })
  assert.deepEqual(heard, [{ time: '08:00' }])
  stop()
  mirror.set({ 'module:insights': { time: '07:00' } })
  assert.equal(heard.length, 1)
})

test('unloading a module drops its app-state watches', async () => {
  const kernel = createMainKernel(createFakeIpcMain().ipcMain)
  const mirror = createModuleAppStateMirror({ filePath, watchFile: false })
  kernel.hostFor('agent-runtime').provideService({ key: 'core.module-app-state' }, () => mirror)
  const heard: unknown[] = []
  kernel.hostFor('insights').watchModuleAppState((values) => heard.push(values))
  await kernel.unregisterModule('insights')
  mirror.set({ 'module:insights': { time: '06:00' } })
  assert.deepEqual(heard, [])
})
