import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

// Where the server keeps what it owns, and where it finds what it ships.
//
// The desktop answers these from Electron (`app.getPath`, `app.isPackaged`,
// `app.getAppPath`, `process.resourcesPath`); a standalone server answers them
// from its flags and the directory its bundle was unpacked into. Every answer is
// read when it is asked for, never captured: the desktop moves `userData` to a
// dev profile before the first window, and a value read earlier would name the
// wrong profile for the life of the process.

export type StudioPaths = {
  /**
   * The server's own data: settings, stores, sealed secrets. Electron's
   * `userData` in the desktop, so nothing moves when the server leaves main.
   */
  dataDir(): string
  /** Where diagnostics logs are appended. Electron's `logs` path in the desktop. */
  logsDir(): string
  /**
   * True for an installed build, false for a source checkout (a dev run, a
   * test, a script). Decides which resource locations are looked at and whether
   * source-only files such as a contributor's dev trust keys count.
   */
  isPackaged(): boolean
  /**
   * The root an installed build unpacks its bundled resources into
   * (`process.resourcesPath` in the desktop); null where there is none.
   */
  resourcesDir(): string | null
  /**
   * The application's own root (`app.getAppPath()`): the checkout in a dev run,
   * the archive in an installed desktop build. Null where there is none.
   */
  appRoot(): string | null
}

export type NodeStudioPathsOptions = {
  dataDir: string
  /**
   * Defaults to `logs` inside the data directory, so a server pointed at a
   * directory keeps everything in it. A server on the default locations passes
   * `defaultServerLocations().logsDir`.
   */
  logsDir?: string
  /**
   * Required, with no default: an installed build trusts only what it shipped
   * (a source checkout also reads a contributor's dev trust keys), so guessing
   * "source checkout" would fail open.
   */
  packaged: boolean
  resourcesDir?: string | null
  appRoot?: string | null
}

/** Paths for a server outside Electron, fixed when it starts (from `--data-dir` or the bootstrap envelope). */
export function createNodeStudioPaths(options: NodeStudioPathsOptions): StudioPaths {
  const logsDir = options.logsDir ?? join(options.dataDir, 'logs')
  return {
    dataDir: () => options.dataDir,
    logsDir: () => logsDir,
    isPackaged: () => options.packaged,
    resourcesDir: () => options.resourcesDir ?? null,
    appRoot: () => options.appRoot ?? null,
  }
}

export type ServerLocationInput = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
}

/**
 * Where a server that was given no data directory keeps its data and logs.
 *
 * The XDG base directories on every host a server is installed on (Linux, a
 * WSL distribution, a Mac reached over SSH), beside the runtime and bundles the
 * WSL install already puts under `~/.local/share/sprintengine-studio/`. A
 * Windows host runs its server in WSL or as the desktop's own, with the
 * desktop's `userData` handed over, so its branch only has to be somewhere
 * sensible.
 */
export function defaultServerLocations(input: ServerLocationInput = {}): { dataDir: string; logsDir: string } {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  if (platform === 'win32') {
    const roaming = nonEmpty(env.APPDATA) ?? win32.join(home, 'AppData', 'Roaming')
    const root = win32.join(roaming, 'sprintengine-studio')
    return { dataDir: win32.join(root, 'data'), logsDir: win32.join(root, 'logs') }
  }
  // The spec says a relative XDG path is invalid and is to be ignored.
  const xdg = (value: string | undefined): string | null => {
    const trimmed = nonEmpty(value)
    return trimmed && posix.isAbsolute(trimmed) ? trimmed : null
  }
  const dataHome = xdg(env.XDG_DATA_HOME) ?? posix.join(home, '.local', 'share')
  const stateHome = xdg(env.XDG_STATE_HOME) ?? posix.join(home, '.local', 'state')
  return {
    dataDir: posix.join(dataHome, 'sprintengine-studio', 'data'),
    logsDir: posix.join(stateHome, 'sprintengine-studio', 'logs'),
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
