import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix as posixPath, win32 as windowsPath } from 'node:path'
import type { IpcMain } from 'electron'
import {
  FOLDER_OPEN_TARGET_IDS,
  isFolderOpenTargetId,
  type FolderOpenRequest,
  type FolderOpenResult,
  type FolderOpenTargetAvailability,
  type FolderOpenTargetId,
} from '../../shared/folder-open-targets'

/**
 * How a target is launched. `reveal` is the OS file manager and goes through
 * the existing show-item-in-folder path; `command` is an argv spawn — the
 * editor's own CLI, or `open -a <bundle>` on macOS when only the app is
 * installed. The folder path is always appended as the final argv element, so
 * no path text is ever interpreted as a flag or shell syntax.
 */
export type FolderOpenLauncher =
  | { kind: 'reveal' }
  | { kind: 'command'; command: string; args: string[] }

export type LauncherProbe = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists(candidatePath: string): boolean
}

type LaunchOutcome = { ok: true } | { ok: false; message: string }

export type FolderOpenIpcDependencies = {
  showItemInFolder(targetPath: string): Promise<void>
  resolveLauncher(target: FolderOpenTargetId): FolderOpenLauncher | null
  runLauncher(command: string, args: string[]): Promise<LaunchOutcome>
  /** Rejects when the folder cannot be reached; same rule show-item-in-folder applies. */
  assertPathReachable(targetPath: string): Promise<void>
}

const EDITOR_LAUNCHERS: Record<Exclude<FolderOpenTargetId, 'finder'>, { cliNames: string[]; macAppNames: string[] }> = {
  vscode: {
    cliNames: ['code'],
    macAppNames: ['Visual Studio Code.app'],
  },
  intellij: {
    cliNames: ['idea'],
    macAppNames: ['IntelliJ IDEA.app', 'IntelliJ IDEA Community Edition.app'],
  },
}

const TARGET_NAMES: Record<FolderOpenTargetId, string> = {
  vscode: 'VS Code',
  intellij: 'IntelliJ IDEA',
  finder: 'the file manager',
}

// A launcher that has not exited by this point started the editor: `code`,
// `idea` and `open` all return immediately, so a still-running child means the
// binary resolved and is doing its work. Only an exit failure or a spawn error
// is reported as a failed launch.
const LAUNCH_SETTLE_MS = 5_000

export function registerFolderOpenIpc(ipcMain: IpcMain, deps: FolderOpenIpcDependencies): void {
  ipcMain.handle('fs:folder-open-targets', async (): Promise<FolderOpenTargetAvailability[]> => {
    return FOLDER_OPEN_TARGET_IDS.map((id) => ({ id, available: deps.resolveLauncher(id) !== null }))
  })

  ipcMain.handle('fs:open-folder-in-target', async (_, request: FolderOpenRequest): Promise<FolderOpenResult> => {
    const target = request?.target
    if (!isFolderOpenTargetId(target)) {
      return { ok: false, target: null, reason: 'unknown_target', message: `Unknown open target: ${String(target)}.` }
    }

    const folderPath = typeof request?.path === 'string' ? request.path : ''
    if (!folderPath.trim()) {
      return { ok: false, target, reason: 'path_unavailable', message: 'No folder was given to open.' }
    }
    try {
      await deps.assertPathReachable(folderPath)
    } catch (error) {
      return { ok: false, target, reason: 'path_unavailable', message: describeError(error) }
    }

    // Resolved again at launch time rather than trusted from the probe: an
    // editor can be uninstalled between the menu opening and the click.
    const launcher = deps.resolveLauncher(target)
    if (!launcher) {
      return { ok: false, target, reason: 'target_unavailable', message: `${TARGET_NAMES[target]} is not installed.` }
    }

    if (launcher.kind === 'reveal') {
      try {
        await deps.showItemInFolder(folderPath)
        return { ok: true, target }
      } catch (error) {
        return { ok: false, target, reason: 'launch_failed', message: describeError(error) }
      }
    }

    // A spawn that cannot even start (a rejected launcher call) is still a
    // launch failure the caller must see, not a rejected invoke it has to catch.
    let outcome: LaunchOutcome
    try {
      outcome = await deps.runLauncher(launcher.command, [...launcher.args, folderPath])
    } catch (error) {
      return { ok: false, target, reason: 'launch_failed', message: describeError(error) }
    }
    if (!outcome.ok) {
      return { ok: false, target, reason: 'launch_failed', message: outcome.message }
    }
    return { ok: true, target }
  })
}

export function createFolderOpenIpcDependencies(
  showItemInFolder: (targetPath: string) => Promise<void>
): FolderOpenIpcDependencies {
  return {
    showItemInFolder,
    resolveLauncher: (target) =>
      resolveFolderOpenLauncher(target, { platform: process.platform, env: process.env, exists: existsSync }),
    runLauncher: (command, args) => runLauncher(command, args, LAUNCH_SETTLE_MS),
    assertPathReachable: (targetPath) => access(targetPath),
  }
}

/**
 * The single source of truth for both channels: availability is "this returns a
 * launcher", so the menu can never offer an editor the open action would fail
 * to start. The file manager always resolves.
 */
export function resolveFolderOpenLauncher(target: FolderOpenTargetId, probe: LauncherProbe): FolderOpenLauncher | null {
  if (target === 'finder') return { kind: 'reveal' }

  const spec = EDITOR_LAUNCHERS[target]
  for (const cliName of spec.cliNames) {
    const resolved = findOnPath(cliName, probe)
    if (resolved) return commandLauncher(resolved, [], probe)
  }

  const appBundle = findMacApp(spec.macAppNames, probe)
  if (appBundle) return { kind: 'command', command: '/usr/bin/open', args: ['-a', appBundle] }

  return null
}

function findOnPath(name: string, probe: LauncherProbe): string | null {
  const isWindows = probe.platform === 'win32'
  const pathValue = probe.env.PATH ?? probe.env.Path ?? ''
  const candidateNames = isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  const joinPath = isWindows ? windowsPath.join : posixPath.join
  for (const dir of pathValue.split(isWindows ? ';' : ':')) {
    if (!dir) continue
    for (const candidateName of candidateNames) {
      const candidate = joinPath(dir, candidateName)
      if (probe.exists(candidate)) return candidate
    }
  }
  return null
}

function findMacApp(appNames: string[], probe: LauncherProbe): string | null {
  if (probe.platform !== 'darwin') return null
  const home = probe.env.HOME ?? ''
  const searchDirs = home ? ['/Applications', posixPath.join(home, 'Applications')] : ['/Applications']
  for (const dir of searchDirs) {
    for (const appName of appNames) {
      const candidate = posixPath.join(dir, appName)
      if (probe.exists(candidate)) return candidate
    }
  }
  return null
}

// Windows ships the editor CLIs as `.cmd`/`.bat` shims, which cannot be spawned
// directly; the command processor runs them, with the path still a separate
// argv element rather than concatenated shell text.
function commandLauncher(command: string, args: string[], probe: LauncherProbe): FolderOpenLauncher {
  if (probe.platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
    return { kind: 'command', command, args }
  }
  return { kind: 'command', command: probe.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
}

function runLauncher(command: string, args: string[], settleMs: number): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let settleTimer: NodeJS.Timeout | undefined
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(settleTimer)
      resolve(outcome)
    }

    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch (error) {
      settle({ ok: false, message: describeError(error) })
      return
    }
    settleTimer = setTimeout(() => settle({ ok: true }), settleMs)
    child.on('error', (error) => settle({ ok: false, message: describeError(error) }))
    child.on('close', (code) => {
      settle(code === 0 ? { ok: true } : { ok: false, message: `${command} exited with code ${String(code)}.` })
    })
    child.unref()
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
