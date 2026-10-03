import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { killProcessTree } from '../process-tree-kill'

type CliSpawnTarget = { file: string; args: string[]; windowsVerbatimArguments?: boolean }

/**
 * How to start an agent CLI that speaks a protocol over stdio.
 *
 * On Windows the resolved command is often an npm shim, `codex.cmd` or
 * `codex.ps1`, and neither is an executable Node can spawn without a shell.
 * A batch shim runs through the command processor and a PowerShell shim
 * through PowerShell, with the rest of the argv passed as it is. Everything
 * else, and every command on macOS and Linux, is spawned directly.
 *
 * The command processor re-reads its line, so the line is built here rather
 * than by Node: every argument quoted, `/s` stripping only the outer pair.
 * Inside quotes the command processor still expands `%VAR%` and ends at a
 * quote, so an argument carrying either is refused instead of being
 * reinterpreted. The arguments are the app's own (`acp`, `app-server`) and the
 * path the CLI was found at.
 *
 * The command processor cannot start in a UNC folder: given one (a folder
 * inside a distribution, `\\wsl.localhost\Ubuntu\…`, which a chat on This PC
 * may run in) it starts in the Windows folder instead, and so would the CLI.
 * There a batch shim gives way to the PowerShell shim npm writes beside it,
 * and PowerShell keeps the folder. A batch file with no such twin is refused
 * with the way out, rather than run in the wrong folder.
 */
export function cliSpawnTarget(
  command: string,
  args: string[],
  deps: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; cwd?: string; exists?: (path: string) => boolean } = {},
): CliSpawnTarget {
  if ((deps.platform ?? process.platform) !== 'win32') return { file: command, args }
  const lower = command.toLowerCase()
  if ((lower.endsWith('.cmd') || lower.endsWith('.bat')) && deps.cwd && /^[\\/]{2}[^\\/]/u.test(deps.cwd)) {
    const twin = command.replace(/\.(?:cmd|bat)$/iu, '.ps1')
    if ((deps.exists ?? existsSync)(twin)) return powerShellTarget(twin, args)
    throw new Error(
      `${command} is a batch file, and Windows cannot start one in ${deps.cwd}: it would run in the Windows folder instead. ` +
        "Set the CLI's command to its .exe or .ps1 in Settings › Agents, or run this chat on its WSL machine.",
    )
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const line = [command, ...args]
      .map((value) => {
        if (/["%\r\n]/.test(value))
          throw new Error(`Cannot start ${command} safely: an argument contains a quote, percent sign or line break.`)
        return `"${value}"`
      })
      .join(' ')
    return {
      file: deps.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    }
  }
  if (lower.endsWith('.ps1')) return powerShellTarget(command, args)
  return { file: command, args }
}

function powerShellTarget(script: string, args: string[]): CliSpawnTarget {
  return {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
  }
}

/**
 * Stop an agent CLI child and whatever it started. On Windows the child is
 * usually the shim's wrapper (the command processor or PowerShell) and the
 * agent is its grandchild, so the whole tree is ended at once. Elsewhere the
 * child is asked to exit and is killed if it has not within two seconds.
 */
export function terminateCliChild(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'kill'>,
  deps: { platform?: NodeJS.Platform; runTaskkill?: (pid: number) => void } = {},
): void {
  if (child.exitCode !== null) return
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    killProcessTree(child, { platform, runTaskkill: deps.runTaskkill })
    return
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 2_000)
  timer.unref()
}
