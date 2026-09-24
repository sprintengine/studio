import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import type { PluginInstallPlatform } from '../shared/plugin-manifest'

/**
 * The PATH a person's own terminal would have, resolved once, and binary lookup
 * against it done in this process.
 *
 * Detecting whether an agent CLI is installed used to start a login shell per
 * CLI — `bash -lc`, then the person's own `$SHELL -ilc` for anything bash could
 * not see — and ask it `command -v`. With ten registered CLIs that is up to
 * twenty shells, each sourcing a `.zshrc` that may load nvm, on every refresh:
 * at boot, and again whenever the pickers asked after the cache ran out. The
 * only thing any of those shells contributed was their PATH, and a PATH does
 * not change between one CLI and the next. So one shell prints it, and every
 * lookup after that is a directory walk in this process.
 *
 * The memo lives for the app session. It is dropped on a forced refresh (an
 * install or an explicit re-check in Settings), because an installer is exactly
 * the thing that appends a line to `~/.zshrc`, and the answer that follows it
 * must see the new directory. A failed resolution is never kept: the next
 * caller tries again rather than inheriting a PATH that is missing the person's
 * own entries for the rest of the session.
 *
 * Host POSIX only (macOS, Linux). WSL and Windows keep their shell probes.
 */

export type LoginShellPathDescriptor = { file: string; args: string[]; timeoutMs: number }

export type LoginShellPathOutcome = { code: number; stdout: string; timedOut: boolean }

/** Marks the line carrying the PATH, so rc-file chatter on stdout cannot be mistaken for it. */
export const LOGIN_PATH_SENTINEL = 'SPRINTENGINE_LOGIN_PATH:'

// A slow `.zshrc` must not wedge detection. The person's own interactive shell
// gets the shorter budget, because bash is still there behind it.
export const USER_SHELL_PATH_TIMEOUT_MS = 5_000
export const LOGIN_BASH_PATH_TIMEOUT_MS = 10_000

const PRINT_PATH_SCRIPT = `printf '\\n%s%s\\n' '${LOGIN_PATH_SENTINEL}' "$PATH"`

/**
 * True when `shell` is one whose own config can be asked for its PATH: a zsh or
 * bash on a host POSIX target. fish is left out because the script is POSIX sh
 * and fish would misparse it; Windows and WSL have no host user shell to ask.
 *
 * Exported because callers acting on a "not installed" verdict need to know
 * whether the person's own shell was consulted: without it, an absent binary may
 * simply be one a plain login bash cannot see.
 */
export function userShellProbeSupported(target: PluginInstallPlatform, shell: string | undefined): shell is string {
  if (target !== 'darwin' && target !== 'linux') return false
  const shellPath = shell?.trim()
  if (!shellPath) return false
  const shellName = shellPath.split('/').pop()
  return shellName === 'zsh' || shellName === 'bash'
}

/**
 * The shells to ask, in order. The person's own zsh/bash as an interactive
 * login shell first — `-i` so `~/.zshrc`, where PATH edits usually live, is
 * sourced exactly as a terminal tab sources it — then a plain login bash, which
 * is what every setup has.
 */
export function loginShellPathDescriptors(shell: string | undefined): LoginShellPathDescriptor[] {
  const plain: LoginShellPathDescriptor = {
    file: 'bash',
    args: ['-lc', PRINT_PATH_SCRIPT],
    timeoutMs: LOGIN_BASH_PATH_TIMEOUT_MS,
  }
  // The target is the host's by construction: this is never asked for WSL.
  if (!userShellProbeSupported('darwin', shell)) return [plain]
  return [{ file: shell.trim(), args: ['-ilc', PRINT_PATH_SCRIPT], timeoutMs: USER_SHELL_PATH_TIMEOUT_MS }, plain]
}

/** The PATH a shell printed, or null when it printed none. The LAST marked line wins. */
export function parseLoginShellPath(stdout: string): string | null {
  let found: string | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith(LOGIN_PATH_SENTINEL)) found = line.slice(LOGIN_PATH_SENTINEL.length).trim()
  }
  return found ? found : null
}

/**
 * The directories to search, in order: the login shell's PATH, then anything on
 * the caller's own PATH it left out. The caller's PATH is the one the app hands
 * a probe (the managed runtime shims in front of the process PATH); a login
 * shell normally keeps it and prepends, but a profile that assigns PATH outright
 * would otherwise make a managed install invisible. Empty and relative entries
 * are dropped — POSIX reads an empty one as "the current directory", which for
 * this process is `/`, and nothing a person installed lives there.
 */
export function searchDirectories(loginPath: string | null, basePath: string | undefined): string[] {
  const directories: string[] = []
  const seen = new Set<string>()
  for (const source of [loginPath, basePath]) {
    for (const entry of (source ?? '').split(delimiter)) {
      if (!entry || !isAbsolute(entry) || seen.has(entry)) continue
      seen.add(entry)
      directories.push(entry)
    }
  }
  return directories
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path `binary` would run as, or null. A name is looked up in
 * `directories` in order, as a shell would; a command override that is already
 * a path is checked where it points. Only an executable regular file counts —
 * an alias or a function in the person's shell cannot be started without that
 * shell, which is the same line the interactive probe drew.
 */
export async function findExecutable(binary: string, directories: string[]): Promise<string | null> {
  const name = binary.trim()
  if (!name) return null
  if (name.includes('/')) {
    const candidate = isAbsolute(name) ? name : resolve(name)
    return (await isExecutableFile(candidate)) ? candidate : null
  }
  for (const directory of directories) {
    const candidate = join(directory, name)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

export type LoginShellPathResolver = {
  /** The login PATH, or null when no shell answered. Shared by every concurrent caller. */
  resolve(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Forget the answer, so the next caller asks a shell again. */
  invalidate(): void
}

export function createLoginShellPathResolver(deps: {
  run(descriptor: LoginShellPathDescriptor, env: NodeJS.ProcessEnv): Promise<LoginShellPathOutcome>
  shell(): string | undefined
}): LoginShellPathResolver {
  let memo: Promise<string | null> | null = null

  async function ask(env: NodeJS.ProcessEnv): Promise<string | null> {
    for (const descriptor of loginShellPathDescriptors(deps.shell())) {
      try {
        const outcome = await deps.run(descriptor, env)
        if (outcome.timedOut) continue
        const path = parseLoginShellPath(outcome.stdout)
        if (path) return path
      } catch {
        // A shell that will not start is one fewer place to ask, not a failure.
      }
    }
    return null
  }

  return {
    resolve(env) {
      if (memo) return memo
      const pending = ask(env)
      memo = pending
      void pending.then((path) => {
        // Kept only when it answered. Dropping a failure lets the next refresh
        // try again instead of living with the process PATH all session.
        if (path === null && memo === pending) memo = null
      })
      return pending
    },
    invalidate() {
      memo = null
    },
  }
}
