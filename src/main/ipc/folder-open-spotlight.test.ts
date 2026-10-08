import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { FOLDER_OPEN_TARGET_IDS } from '../../shared/folder-open-targets'

// The real-machine editor probe asks Spotlight without holding the main
// thread. The boot-discovery pass runs it right after the main window is
// created, so a synchronous `mdfind` there delayed the window's own document.

type ExecFileCallback = (error: Error | null, stdout: string) => void

const spawned = vi.hoisted(() => ({
  execFile: [] as { args: readonly string[]; callback: ExecFileCallback }[],
  execFileSync: 0,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execFile: (_file: string, args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
      spawned.execFile.push({ args, callback })
    },
    execFileSync: () => {
      spawned.execFileSync += 1
      throw new Error('the editor probe must not spawn synchronously')
    },
  }
})

// Nothing found in the conventional folders, whatever this machine has installed.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, existsSync: () => false }
})

const realPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  spawned.execFile.length = 0
  spawned.execFileSync = 0
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

test('the editor probe answers from Spotlight without blocking, in one lookup for every editor', async () => {
  const { listFolderOpenTargetAvailability, resolveFolderOpenLauncherHere } = await import('./folder-open-ipc')

  // The boot pass and a workspace bar ask in the same moment.
  const availability = listFolderOpenTargetAvailability(resolveFolderOpenLauncherHere)
  const launcher = resolveFolderOpenLauncherHere('intellij')

  // Both calls have returned while Spotlight is still working: nothing ran synchronously.
  assert.equal(spawned.execFileSync, 0)
  // Microtasks run, so every missing editor has asked.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(spawned.execFile.length, 1, 'one mdfind, however many editors and callers ask')
  const [{ args, callback }] = spawned.execFile
  assert.deepEqual(args.slice(0, 2), ['-attr', 'kMDItemCFBundleIdentifier'])
  assert.ok(args[2]?.includes('com.jetbrains.intellij') && args[2]?.includes('com.microsoft.VSCode'))

  callback(
    null,
    [
      '/Volumes/work/IntelliJ IDEA.app   kMDItemCFBundleIdentifier = com.jetbrains.intellij',
      '/Users/dev/.Trash/Zed.app   kMDItemCFBundleIdentifier = dev.zed.Zed',
      '',
    ].join('\n'),
  )

  assert.deepEqual(await launcher, {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Volumes/work/IntelliJ IDEA.app'],
  })
  assert.deepEqual(
    await availability,
    FOLDER_OPEN_TARGET_IDS.map((id) => ({ id, available: id === 'intellij' || id === 'finder' })),
    'a trashed copy is not an install',
  )
  assert.equal(spawned.execFileSync, 0)
})

test('Spotlight’s listing is split by bundle id', async () => {
  const { parseSpotlightBundles } = await import('./folder-open-ipc')
  const bundles = parseSpotlightBundles(
    [
      '/Applications/Cursor.app   kMDItemCFBundleIdentifier = com.todesktop.230313mzl4w4u92',
      '/Volumes/work/My Tools/Zed.app   kMDItemCFBundleIdentifier = "dev.zed.Zed"',
      '/Applications/Zed.app   kMDItemCFBundleIdentifier = dev.zed.Zed',
      'not a listing line',
    ].join('\n'),
  )
  assert.deepEqual(bundles.get('com.todesktop.230313mzl4w4u92'), ['/Applications/Cursor.app'])
  assert.deepEqual(bundles.get('dev.zed.Zed'), ['/Volumes/work/My Tools/Zed.app', '/Applications/Zed.app'])
  assert.equal(bundles.size, 2)
})
