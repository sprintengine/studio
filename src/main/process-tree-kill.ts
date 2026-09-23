import { spawn } from 'node:child_process'

/**
 * Ends a child process and, on Windows, everything it started.
 *
 * `child.kill()` on Windows is `TerminateProcess` on that one pid. The helpers
 * this app starts with a deadline are wrappers — `powershell.exe -Command`,
 * `cmd.exe /c`, `wsl.exe -e bash -lc` — and the thing that actually hangs is
 * what the wrapper launched: an agent CLI's `--version`, which is itself a
 * `.cmd` shim over `node.exe`. Killing only the wrapper leaves those running
 * with no parent the app knows about, still holding the stdout pipe the app is
 * waiting on, and each one keeps its console host besides. They do not show up
 * as this app in Task Manager, which is the point: nothing ever reaps them.
 *
 * `taskkill /T` walks the tree by parent pid and ends it from the leaves up.
 * It is itself a process start, but it only runs on the rare path where a
 * deadline was missed. On POSIX a plain kill is kept: there the wrappers
 * `exec` the CLI or share its process group, and this has not been the leak.
 */
export function killProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  deps: {
    platform?: NodeJS.Platform
    runTaskkill?: (pid: number) => void
  } = {},
): void {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    const runTaskkill = deps.runTaskkill ?? defaultRunTaskkill
    try {
      runTaskkill(child.pid)
      return
    } catch {
      // Fall through to the single-process kill: better than nothing.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

function defaultRunTaskkill(pid: number): void {
  const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  // A missing taskkill (a stripped-down image) or a pid that already exited is
  // not worth surfacing; the deadline's caller has already moved on.
  killer.on('error', () => {})
}
