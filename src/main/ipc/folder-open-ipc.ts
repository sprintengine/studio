import { execFileSync, spawn } from 'node:child_process'
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
  /**
   * macOS only: where an application with one of these bundle identifiers is
   * installed, wherever that is. The directory scan above it only knows the
   * conventional folders; an app dragged onto another volume (`/Volumes/work/
   * IntelliJ IDEA.app`) is still an installed app, and Launch Services knows
   * about it even when we do not. Absent in a probe that has no such lookup.
   */
  locateAppByBundleId?(bundleIds: readonly string[]): string | null
}

type LaunchOutcome = { ok: true } | { ok: false; message: string }

export type FolderOpenIpcDependencies = {
  showItemInFolder(targetPath: string): Promise<void>
  resolveLauncher(target: FolderOpenTargetId): FolderOpenLauncher | null
  runLauncher(command: string, args: string[]): Promise<LaunchOutcome>
  /** Rejects when the folder cannot be reached; same rule show-item-in-folder applies. */
  assertPathReachable(targetPath: string): Promise<void>
}

// The bundle names cover every spelling the vendors ship: the Community edition
// installs as "IntelliJ IDEA CE.app", and JetBrains Toolbox writes
// "IntelliJ IDEA Ultimate.app". The bundle ids are what Launch Services indexes
// the same app under whatever it was renamed to on disk.
const EDITOR_LAUNCHERS: Record<
  Exclude<FolderOpenTargetId, 'finder'>,
  { cliNames: string[]; macAppNames: string[]; macBundleIds: string[] }
> = {
  vscode: {
    cliNames: ['code'],
    macAppNames: ['Visual Studio Code.app'],
    macBundleIds: ['com.microsoft.VSCode'],
  },
  intellij: {
    cliNames: ['idea'],
    macAppNames: [
      'IntelliJ IDEA.app',
      'IntelliJ IDEA Ultimate.app',
      'IntelliJ IDEA CE.app',
      'IntelliJ IDEA Community Edition.app',
    ],
    macBundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
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

/**
 * The editor probe, as a plain call. Shared by the `fs:folder-open-targets`
 * handler and the boot-discovery pass so both answer "which editors are
 * installed" the same way. Synchronous: it walks PATH and the application
 * folders with `existsSync`, and only for an editor none of that finds does it
 * ask Spotlight once (cached, see `locateAppByBundleIdHere`).
 */
export function listFolderOpenTargetAvailability(
  resolveLauncher: (target: FolderOpenTargetId) => FolderOpenLauncher | null
): FolderOpenTargetAvailability[] {
  return FOLDER_OPEN_TARGET_IDS.map((id) => ({ id, available: resolveLauncher(id) !== null }))
}

/** `resolveFolderOpenLauncher` against the real machine. */
export function resolveFolderOpenLauncherHere(target: FolderOpenTargetId): FolderOpenLauncher | null {
  return resolveFolderOpenLauncher(target, {
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    locateAppByBundleId: locateAppByBundleIdHere,
  })
}

// Spotlight answers are remembered for a minute. The probe runs at boot, again
// for every workspace bar that mounts, and once more at launch time; `mdfind`
// costs tens of milliseconds on the main process, and the answer does not
// change between one workspace switch and the next. A minute is short enough
// that an editor installed while the app is open shows up on the next probe.
const SPOTLIGHT_CACHE_MS = 60_000
const spotlightCache = new Map<string, { at: number; path: string | null }>()

/**
 * Ask Spotlight where an app with one of these bundle ids lives. The directory
 * scan finds the conventional installs; this finds the rest — an app kept on a
 * second volume, or a bundle renamed on disk. `mdfind` is the same index Launch
 * Services opens apps through, so a hit here is an app `open -a` can start.
 *
 * Conventional folders win when Spotlight lists several copies (an install and
 * a stray download), and anything in the Trash or a Time Machine backup is not
 * an install at all. Any failure — Spotlight off, the volume unindexed, a slow
 * index — is "not found", never an error: the menu simply omits the editor.
 */
function locateAppByBundleIdHere(bundleIds: readonly string[]): string | null {
  if (process.platform !== 'darwin' || bundleIds.length === 0) return null
  const key = bundleIds.join('|')
  const cached = spotlightCache.get(key)
  if (cached && Date.now() - cached.at < SPOTLIGHT_CACHE_MS) return cached.path

  let found: string | null = null
  try {
    const query = bundleIds.map((id) => `kMDItemCFBundleIdentifier == "${id}"`).join(' || ')
    const output = execFileSync('/usr/bin/mdfind', [query], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    found = pickInstalledBundle(output.split('\n'), process.env.HOME ?? '')
  } catch {
    found = null
  }
  spotlightCache.set(key, { at: Date.now(), path: found })
  return found
}

/** The bundle to launch out of Spotlight's list, or null when none is an install. */
export function pickInstalledBundle(candidates: readonly string[], home: string): string | null {
  const bundles = candidates
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.app'))
    .filter((line) => !line.includes('/.Trash/') && !line.includes('Backups.backupdb'))
  if (bundles.length === 0) return null
  const rank = (bundle: string): number => {
    if (bundle.startsWith('/Applications/')) return 0
    if (home && bundle.startsWith(posixPath.join(home, 'Applications') + '/')) return 1
    return 2
  }
  return [...bundles].sort((a, b) => rank(a) - rank(b))[0] ?? null
}

export function registerFolderOpenIpc(ipcMain: IpcMain, deps: FolderOpenIpcDependencies): void {
  ipcMain.handle('fs:folder-open-targets', async (): Promise<FolderOpenTargetAvailability[]> => {
    return listFolderOpenTargetAvailability(deps.resolveLauncher)
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
    resolveLauncher: resolveFolderOpenLauncherHere,
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

  // Nowhere we know to look: ask Launch Services where the app actually is.
  if (probe.platform === 'darwin' && probe.locateAppByBundleId) {
    const located = probe.locateAppByBundleId(spec.macBundleIds)
    if (located) return { kind: 'command', command: '/usr/bin/open', args: ['-a', located] }
  }

  return null
}

/**
 * Directories the editor CLIs live in when they are installed but not on PATH:
 * JetBrains Toolbox writes its `idea` shim to a scripts folder it asks the user
 * to add to PATH (and most never do), and the vscode target's Windows installer
 * offers PATH as an unticked box. A GUI app's PATH is the login shell's, which
 * is what makes these worth knowing by name.
 */
function wellKnownCliDirs(probe: LauncherProbe): string[] {
  const { platform, env } = probe
  if (platform === 'darwin') {
    const home = env.HOME ?? ''
    return home ? [posixPath.join(home, 'Library/Application Support/JetBrains/Toolbox/scripts')] : []
  }
  if (platform === 'win32') {
    const dirs: string[] = []
    const local = env.LOCALAPPDATA
    if (local) {
      dirs.push(windowsPath.join(local, 'JetBrains', 'Toolbox', 'scripts'))
      dirs.push(windowsPath.join(local, 'Programs', 'Microsoft VS Code', 'bin'))
    }
    const programFiles = env.ProgramFiles
    if (programFiles) dirs.push(windowsPath.join(programFiles, 'Microsoft VS Code', 'bin'))
    return dirs
  }
  const home = env.HOME ?? ''
  return home ? [posixPath.join(home, '.local/share/JetBrains/Toolbox/scripts')] : []
}

function findOnPath(name: string, probe: LauncherProbe): string | null {
  const isWindows = probe.platform === 'win32'
  const pathValue = probe.env.PATH ?? probe.env.Path ?? ''
  const candidateNames = isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  const joinPath = isWindows ? windowsPath.join : posixPath.join
  // PATH first, so a shim the person put there deliberately wins over a default
  // install location; the well-known directories are the fallback.
  const dirs = [...pathValue.split(isWindows ? ';' : ':'), ...wellKnownCliDirs(probe)]
  for (const dir of dirs) {
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
  // JetBrains Toolbox keeps its installs in a folder of their own under the
  // user's Applications, so that folder is one of the places an IDE lives.
  const searchDirs = home
    ? ['/Applications', posixPath.join(home, 'Applications'), posixPath.join(home, 'Applications/JetBrains Toolbox')]
    : ['/Applications']
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
