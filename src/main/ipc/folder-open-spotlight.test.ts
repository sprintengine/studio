import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

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

test('the editor probe answers from Spotlight without blocking, and shares one lookup', async () => {
  const { listFolderOpenTargetAvailability, resolveFolderOpenLauncherHere } = await import('./folder-open-ipc')

  // The boot pass and a workspace bar ask in the same moment.
  const availability = listFolderOpenTargetAvailability(resolveFolderOpenLauncherHere)
  const launcher = resolveFolderOpenLauncherHere('intellij')

  // Both calls have returned while Spotlight is still working: nothing ran synchronously.
  assert.equal(spawned.execFileSync, 0)
  const intellijLookups = spawned.execFile.filter(({ args }) => args[0]?.includes('com.jetbrains.intellij'))
  assert.equal(intellijLookups.length, 1, 'one mdfind for IntelliJ, however many callers ask')

  for (const { args, callback } of spawned.execFile) {
    callback(null, args[0]?.includes('com.jetbrains.intellij') ? '/Volumes/work/IntelliJ IDEA.app\n' : '')
  }

  assert.deepEqual(await launcher, {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Volumes/work/IntelliJ IDEA.app'],
  })
  assert.deepEqual(await availability, [
    { id: 'vscode', available: false },
    { id: 'intellij', available: true },
    { id: 'finder', available: true },
  ])
  assert.equal(spawned.execFileSync, 0)
})
