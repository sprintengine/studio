// Deleting the app's own data once the app has quit.
//
// The profile directory cannot be deleted by the process that has it open
// (on Windows its files are locked outright), so a small detached process
// waits for this one to exit and deletes the paths then. It is started when
// the person asks for it, and does nothing until the app is gone.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

/** The command that waits for `pid` to exit and deletes `paths`, for this platform. */
export function appDataDeletionCommand(
  pid: number,
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const list = paths.map(quotePowerShell).join(', ')
    return {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; ` +
          `Remove-Item -LiteralPath @(${list}) -Recurse -Force -ErrorAction SilentlyContinue`,
      ],
    }
  }
  return {
    command: '/bin/sh',
    // The paths ride as positional arguments, never inside the script text.
    args: [
      '-c',
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done; rm -rf -- "$@"`,
      'sprintengine-cleanup',
      ...paths,
    ],
  }
}

/**
 * Whether a path is one this may delete: absolute, at least three levels deep,
 * and not the home folder or anything above it. A development profile can be
 * pointed anywhere (`SPRINTENGINE_USER_DATA_DIR`), and a recursive delete of the
 * wrong one is not undone.
 */
export function isDeletableAppDataPath(path: string, home: string = homedir()): boolean {
  if (!isAbsolute(path)) return false
  const target = resolve(path)
  const segments = target.split(/[\\/]+/u).filter(Boolean)
  if (segments.length < 3) return false
  const homeResolved = resolve(home)
  const within = (inner: string, outer: string) => outer === inner || outer.startsWith(`${inner}${sep}`)
  return !within(target, homeResolved)
}

export async function scheduleAppDataDeletion(paths: readonly string[], pid: number = process.pid): Promise<void> {
  const deletable = paths.filter((path) => isDeletableAppDataPath(path))
  if (deletable.length === 0) return
  const { command, args } = appDataDeletionCommand(pid, deletable)
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}
