import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  createFolderOpenIpcDependencies,
  registerFolderOpenIpc,
  resolveFolderOpenLauncher,
  type FolderOpenIpcDependencies,
  type FolderOpenLauncher,
  type LauncherProbe,
} from './folder-open-ipc'
import type { FolderOpenResult, FolderOpenTargetAvailability } from '../../shared/folder-open-targets'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
  }
}

function probe(options: {
  platform: NodeJS.Platform
  installed: string[]
  env?: NodeJS.ProcessEnv
}): LauncherProbe {
  const installed = new Set(options.installed)
  return {
    platform: options.platform,
    env: options.env ?? { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/dev' },
    exists: (candidate) => installed.has(candidate),
  }
}

void main()

async function main(): Promise<void> {
  assertProbeResolvesEachTarget()
  await assertProbeChannelReportsEveryTarget()
  await assertOpenSucceeds()
  await assertOpenFails()
  await assertRealDependenciesAreWired()
}

// Availability is "the launcher resolves": the CLI on PATH, else the macOS app
// bundle. Each editor is checked present and absent; the file manager always
// resolves.
function assertProbeResolvesEachTarget(): void {
  const noEditors = probe({ platform: 'darwin', installed: [] })
  assert.deepEqual(resolveFolderOpenLauncher('finder', noEditors), { kind: 'reveal' })
  assert.equal(resolveFolderOpenLauncher('vscode', noEditors), null)
  assert.equal(resolveFolderOpenLauncher('intellij', noEditors), null)

  const cliInstalled = probe({ platform: 'darwin', installed: ['/usr/local/bin/code', '/usr/local/bin/idea'] })
  assert.deepEqual(resolveFolderOpenLauncher('vscode', cliInstalled), {
    kind: 'command',
    command: '/usr/local/bin/code',
    args: [],
  })
  assert.deepEqual(resolveFolderOpenLauncher('intellij', cliInstalled), {
    kind: 'command',
    command: '/usr/local/bin/idea',
    args: [],
  })

  // No CLI, but the app bundle is installed: launch through `open -a`.
  const bundleOnly = probe({
    platform: 'darwin',
    installed: ['/Applications/Visual Studio Code.app', '/Users/dev/Applications/IntelliJ IDEA.app'],
  })
  assert.deepEqual(resolveFolderOpenLauncher('vscode', bundleOnly), {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Applications/Visual Studio Code.app'],
  })
  assert.deepEqual(resolveFolderOpenLauncher('intellij', bundleOnly), {
    kind: 'command',
    command: '/usr/bin/open',
    args: ['-a', '/Users/dev/Applications/IntelliJ IDEA.app'],
  })

  // A macOS bundle is not a launcher on other platforms.
  const linuxBundlePaths = probe({
    platform: 'linux',
    installed: ['/Applications/Visual Studio Code.app'],
    env: { PATH: '/usr/bin', HOME: '/home/dev' },
  })
  assert.equal(resolveFolderOpenLauncher('vscode', linuxBundlePaths), null)

  // Windows ships `code.cmd`, which the command processor has to run.
  const windows = probe({
    platform: 'win32',
    installed: ['C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'],
    env: { Path: 'C:\\Program Files\\Microsoft VS Code\\bin', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
  })
  assert.deepEqual(resolveFolderOpenLauncher('vscode', windows), {
    kind: 'command',
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'],
  })
  assert.equal(resolveFolderOpenLauncher('intellij', windows), null)
}

async function assertProbeChannelReportsEveryTarget(): Promise<void> {
  const { probeTargets } = mountHandlers({
    resolveLauncher: (target) => (target === 'vscode' ? null : { kind: 'reveal' }),
  })

  const targets = (await probeTargets(null)) as FolderOpenTargetAvailability[]
  assert.deepEqual(targets, [
    { id: 'vscode', available: false },
    { id: 'intellij', available: true },
    { id: 'finder', available: true },
  ])
}

async function assertOpenSucceeds(): Promise<void> {
  const revealed: string[] = []
  const launched: Array<{ command: string; args: string[] }> = []
  const { openFolder } = mountHandlers({
    showItemInFolder: async (targetPath) => {
      revealed.push(targetPath)
    },
    resolveLauncher: (target) =>
      target === 'finder' ? { kind: 'reveal' } : { kind: 'command', command: '/usr/local/bin/code', args: [] },
    runLauncher: async (command, args) => {
      launched.push({ command, args })
      return { ok: true }
    },
  })

  assert.deepEqual(await openFolder(null, { target: 'finder', path: '/repo' }), { ok: true, target: 'finder' })
  assert.deepEqual(revealed, ['/repo'])

  assert.deepEqual(await openFolder(null, { target: 'vscode', path: '/repo' }), { ok: true, target: 'vscode' })
  assert.deepEqual(launched, [{ command: '/usr/local/bin/code', args: ['/repo'] }])
}

// Every failure is a typed result the caller can surface, and a failed launch
// never quietly falls through to another target.
async function assertOpenFails(): Promise<void> {
  const attempted: string[] = []
  const { openFolder } = mountHandlers({
    showItemInFolder: async () => {
      throw new Error('reveal refused')
    },
    resolveLauncher: (target) =>
      target === 'intellij' ? null : target === 'finder' ? { kind: 'reveal' } : { kind: 'command', command: 'code', args: [] },
    runLauncher: async (command) => {
      attempted.push(command)
      return { ok: false, message: 'code exited with code 1.' }
    },
    assertPathReachable: async (targetPath) => {
      if (targetPath !== '/repo') throw new Error(`ENOENT: no such file or directory, access '${targetPath}'`)
    },
  })

  assert.deepEqual(await openFolder(null, { target: 'atom', path: '/repo' }), {
    ok: false,
    target: null,
    reason: 'unknown_target',
    message: 'Unknown open target: atom.',
  })

  assert.deepEqual(await openFolder(null, { target: 'vscode', path: '   ' }), {
    ok: false,
    target: 'vscode',
    reason: 'path_unavailable',
    message: 'No folder was given to open.',
  })

  const missingPath = (await openFolder(null, { target: 'vscode', path: '/gone' })) as FolderOpenResult
  assert.equal(missingPath.ok, false)
  assert.equal(missingPath.ok === false && missingPath.reason, 'path_unavailable')

  assert.deepEqual(await openFolder(null, { target: 'intellij', path: '/repo' }), {
    ok: false,
    target: 'intellij',
    reason: 'target_unavailable',
    message: 'IntelliJ IDEA is not installed.',
  })

  assert.deepEqual(await openFolder(null, { target: 'vscode', path: '/repo' }), {
    ok: false,
    target: 'vscode',
    reason: 'launch_failed',
    message: 'code exited with code 1.',
  })

  const revealFailure = (await openFolder(null, { target: 'finder', path: '/repo' })) as FolderOpenResult
  assert.deepEqual(revealFailure, {
    ok: false,
    target: 'finder',
    reason: 'launch_failed',
    message: 'reveal refused',
  })

  // Only the requested target was ever launched.
  assert.deepEqual(attempted, ['code'])

  // A launcher that cannot start at all is still a typed result, not a rejected
  // invoke the caller has to catch.
  const { openFolder: openWithBrokenSpawn } = mountHandlers({
    resolveLauncher: () => ({ kind: 'command', command: 'code', args: [] }),
    runLauncher: async () => {
      throw new Error('spawn code ENOENT')
    },
  })
  assert.deepEqual(await openWithBrokenSpawn(null, { target: 'vscode', path: '/repo' }), {
    ok: false,
    target: 'vscode',
    reason: 'launch_failed',
    message: 'spawn code ENOENT',
  })
}

// The real dependency set must reach the same reveal handler the rest of the
// app uses, and reject an unreachable path before anything is spawned.
async function assertRealDependenciesAreWired(): Promise<void> {
  const revealed: string[] = []
  const deps = createFolderOpenIpcDependencies(async (targetPath) => {
    revealed.push(targetPath)
  })

  await deps.showItemInFolder('/repo')
  assert.deepEqual(revealed, ['/repo'])
  assert.deepEqual(deps.resolveLauncher('finder'), { kind: 'reveal' })
  await assert.rejects(deps.assertPathReachable(join(__dirname, 'definitely-missing-folder')))
}

function mountHandlers(overrides: Partial<FolderOpenIpcDependencies>): {
  probeTargets: Handler
  openFolder: (event: unknown, request: { target: string; path: string }) => Promise<unknown>
} {
  const ipcMain = createIpcMain()
  registerFolderOpenIpc(ipcMain as unknown as Parameters<typeof registerFolderOpenIpc>[0], {
    showItemInFolder: async () => {},
    resolveLauncher: (): FolderOpenLauncher | null => null,
    runLauncher: async () => ({ ok: true }),
    assertPathReachable: async () => {},
    ...overrides,
  })

  const probeTargets = ipcMain.handlers.get('fs:folder-open-targets')
  const openFolder = ipcMain.handlers.get('fs:open-folder-in-target')
  assert.ok(probeTargets, 'probe channel should be registered')
  assert.ok(openFolder, 'open channel should be registered')
  return { probeTargets, openFolder }
}
