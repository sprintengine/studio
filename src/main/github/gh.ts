// THE `gh` runner for the whole main process (epic `pull-request-marks`,
// decision 11). Every GitHub read and write this app makes goes through the
// GitHub CLI — never REST — so that gh's own credential store is the single
// auth source and GitHub Enterprise Server hosts come free.
//
// It lives here, in a neutral module, because it used to live inside the review
// provider while a second, weaker spawner sat in `automations/pull-request.ts`.
// The two were not equivalent: only this one retries through the user's login
// shell, and a GUI-launched app on macOS does not inherit the shell PATH, so a
// Homebrew or nvm `gh` was invisible to the weaker one — which reported "no
// pull request" for a pull request that was plainly there. One runner, one
// answer.
//
// THE `found` FLAG IS THE POINT. `found: false` means the binary itself is
// absent; anything else is gh having run and having an opinion. A caller that
// writes an answer down must tell those apart: "there is no pull request" and
// "I could not ask" are different facts, and only the first may be recorded.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { PullRequestProvider } from '../../shared/review/changeset'

const execFileAsync = promisify(execFile)

/**
 * Cap on what one `gh` call may return. A pull request diff is the biggest
 * thing we ask for; the review provider rejects anything over its own
 * `MAX_PATCH_BYTES` after the fact, so this only has to be comfortably larger
 * than that (it matches the automations spawner's old buffer, so moving that
 * call site onto this runner cannot shrink what it could read).
 */
export const GH_MAX_BUFFER_BYTES = 20 * 1024 * 1024

export interface GhResult {
  found: boolean // false only when the gh binary itself is absent
  code: number
  stdout: string
  stderr: string
  /**
   * The child was killed because it outlived {@link GhRunOptions.timeoutMs}.
   * A caller that records answers must read this as "I could not ask" and never
   * as an empty result — it is the offline/hung case, not a fact about GitHub.
   */
  timedOut?: boolean
}

/** Per-call options. `cwd` is what lets a repository-scoped read (`gh pr list`
 *  in a checkout) share the runner with the repo-argument reads. */
export interface GhRunOptions {
  cwd?: string
  /**
   * How long the child may run before it is KILLED. Without it a caller that
   * merely stops waiting (a `Promise.race` against a timer) leaves a `gh` — and,
   * on the login-shell fallback, a whole `$SHELL -ilc` — running behind every
   * abandoned read, so a hover on an unreachable host leaks one process per
   * probe. Passed straight to `execFile`'s own `timeout`/`killSignal`, so the
   * process table is what enforces it.
   */
  timeoutMs?: number
}

export interface GhRunner {
  available(): Promise<boolean>
  run(args: string[], options?: GhRunOptions): Promise<GhResult>
}

/** The one spawn this module makes, behind a seam so tests never touch a real `gh`. */
export type GhSpawn = (
  file: string,
  args: string[],
  options: {
    cwd?: string
    maxBuffer: number
    windowsHide: boolean
    /** `execFile`'s own timeout: the child is signalled, not merely abandoned. */
    timeout?: number
    killSignal?: NodeJS.Signals
  }
) => Promise<{ stdout: string; stderr: string }>

export type GhRunnerEnvironment = {
  spawn?: GhSpawn
  /** `process.env.SHELL` by default; the login shell the PATH fallback runs through. */
  shell?: string | undefined
  platform?: NodeJS.Platform
}

// Default gh runner: a direct spawn, then — when the binary is not on PATH — a
// retry through the user's login+interactive shell. A GUI-launched app on macOS
// does not inherit the shell PATH, so a Homebrew/nvm `gh` is invisible to a bare
// spawn but present in the shell that PTY terminals use (mirrors detectCli's
// $SHELL -ilc fallback in cli-runtime-install.ts).
export function createDefaultGhRunner(environment: GhRunnerEnvironment = {}): GhRunner {
  const spawn: GhSpawn =
    environment.spawn
    ?? ((file, args, options) => execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>)
  const shell = environment.shell !== undefined ? environment.shell : process.env.SHELL
  const platform = environment.platform ?? process.platform

  const runDirect = async (args: string[], options: GhRunOptions): Promise<GhResult> => {
    try {
      const { stdout, stderr } = await spawn('gh', args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...spawnTimeout(options),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        windowsHide: true,
      })
      return { found: true, code: 0, stdout, stderr }
    } catch (error) {
      return resultFromSpawnError(error)
    }
  }
  const runViaShell = async (args: string[], options: GhRunOptions): Promise<GhResult | null> => {
    const descriptor = buildShellGhDescriptor(args, shell, platform)
    if (!descriptor) return null
    try {
      const { stdout, stderr } = await spawn(descriptor.file, descriptor.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...spawnTimeout(options),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        windowsHide: true,
      })
      return { found: true, code: 0, stdout, stderr }
    } catch (error) {
      return resultFromSpawnError(error)
    }
  }
  const run = async (args: string[], options: GhRunOptions = {}): Promise<GhResult> => {
    const direct = await runDirect(args, options)
    if (direct.found) return direct
    return (await runViaShell(args, options)) ?? direct
  }
  return {
    run,
    async available() {
      const result = await run(['--version'])
      return result.found && result.code === 0
    },
  }
}

/** The kill terms for one call, or nothing at all when the caller set no bound. */
function spawnTimeout(options: GhRunOptions): { timeout?: number; killSignal?: NodeJS.Signals } {
  const timeoutMs = options.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return {}
  return { timeout: Math.round(timeoutMs), killSignal: 'SIGTERM' }
}

function resultFromSpawnError(error: unknown): GhResult {
  const err = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string }
  if (err.code === 'ENOENT') return { found: false, code: -1, stdout: '', stderr: '' }
  // `execFile` reports its own timeout as a killed child (`killed: true`, and a
  // signal rather than an exit code). The binary was found and run, so this is
  // never `found: false`; it is a read that did not happen.
  const timedOut = err.killed === true || (typeof err.signal === 'string' && err.signal.length > 0)
  return {
    found: true,
    code: typeof err.code === 'number' ? err.code : 1,
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  }
}

/** The `$SHELL -ilc 'gh …'` command line, or null where that fallback does not apply. */
export function buildShellGhDescriptor(
  args: string[],
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } | null {
  if (platform !== 'darwin' && platform !== 'linux') return null
  const shellPath = shell?.trim()
  if (!shellPath) return null
  const shellName = shellPath.split('/').pop()
  if (shellName !== 'zsh' && shellName !== 'bash') return null
  const command = ['gh', ...args].map(posixSingleQuote).join(' ')
  return { file: shellPath, args: ['-ilc', command] }
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Resolves the REST token from the same environment variables gh reads.
// github.com is fixed to api.github.com so GH_TOKEN can only ever reach GitHub.
// A GHES host, though, comes straight from the pasted URL: handing the enterprise
// token to an arbitrary host would leak it, so the token is released only when the
// host matches an explicitly configured enterprise host (gh's own GH_HOST). An
// unconfigured or mismatched host falls through unauthenticated.
//
// Only the review provider's REST fallback uses this; everything newer is
// gh-only (decision 11) and never sees a token at all.
export function defaultResolveToken(host: string, provider: PullRequestProvider): Promise<string | null> {
  if (provider === 'github') return Promise.resolve(pickEnv('GH_TOKEN', 'GITHUB_TOKEN'))
  const configuredHost = (process.env.GH_HOST ?? process.env.GH_ENTERPRISE_HOST ?? '').trim().toLowerCase()
  if (!configuredHost || configuredHost !== host.toLowerCase()) return Promise.resolve(null)
  return Promise.resolve(pickEnv('GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'))
}

function pickEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

/**
 * The shared runner every main-process caller uses. One process-wide instance
 * so "one runner" is literally true — a second `createDefaultGhRunner()` in a
 * call site would be a second spawner's worth of drift waiting to happen.
 */
let shared: GhRunner | null = null

export function sharedGhRunner(): GhRunner {
  if (!shared) shared = createDefaultGhRunner()
  return shared
}
