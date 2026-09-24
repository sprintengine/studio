import { execFile } from 'child_process'
import type { GitCommandResult } from './git'
import { killProcessTree } from './process-tree-kill'
import type { ExecutionHost } from './hosts/execution-host'

/**
 * The one place a git process is started for the app's own reads and writes.
 *
 * What a git invocation does decides how long it may run and whether it may
 * take git's optional locks:
 *
 * - `read` answers a question and changes nothing. It gets a short deadline,
 *   because every read here feeds a view, and a view waiting on a git that is
 *   stuck behind a spun-down volume or a network mount is better told "failed"
 *   than left spinning. It also runs with `GIT_OPTIONAL_LOCKS=0`: `git status`
 *   otherwise refreshes the index's stat cache and takes `index.lock` to do it,
 *   and a poll holding that lock for a moment is exactly what makes an agent's
 *   own `git commit` fail with "index.lock exists". Without the lock our reads
 *   also never rewrite `.git/index`, so the gitdir watcher that drives the views
 *   (git-repo-watch.ts) is never woken by our own reading.
 * - `network` talks to a remote and changes only remote-tracking refs. It gets
 *   a long deadline: a fetch over a slow link is legitimate, a fetch that has
 *   sat stalled for two minutes is not.
 * - `write` changes the repository and gets NO deadline. A commit, merge,
 *   rebase, checkout, push or `worktree add` runs the repository's hooks, which
 *   can run a test suite for minutes, and killing a write part-way leaves an
 *   `index.lock` behind that blocks every later write until someone deletes it
 *   by hand. Waiting is the lesser harm.
 *
 * An unrecognised subcommand is a write: the safe default is the one that
 * never kills.
 */
export type GitCommandKind = 'read' | 'network' | 'write'

export const GIT_READ_TIMEOUT_MS = 15_000
export const GIT_NETWORK_TIMEOUT_MS = 120_000

const READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'cherry',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  // `--write-tree` stores the merged tree's objects and nothing else: no ref,
  // no index, no working tree moves, so it is a read for every purpose here.
  'merge-tree',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'var',
  'version',
])

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'ls-remote'])

// `branch` and `tag` list when asked to and write otherwise. Any of these flags
// means git is listing, provided none of the write flags below sits beside it.
const LIST_FLAGS = new Set([
  '--list',
  '-l',
  '--format',
  '--sort',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
])
const LIST_WRITE_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '-f',
  '--force',
  '--edit-description',
  '-a',
  '-s',
  '--annotate',
  '--sign',
])

function flagName(arg: string): string {
  const equals = arg.indexOf('=')
  return equals === -1 ? arg : arg.slice(0, equals)
}

/** The subcommand and its arguments, past any global options (`-c k=v`, `-C dir`). */
function splitSubcommand(args: readonly string[]): { subcommand: string | null; rest: readonly string[] } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-c' || arg === '-C') {
      index += 1
      continue
    }
    if (arg === '--version') return { subcommand: 'version', rest: [] }
    if (arg.startsWith('-')) continue
    return { subcommand: arg, rest: args.slice(index + 1) }
  }
  return { subcommand: null, rest: [] }
}

export function classifyGitCommand(args: readonly string[]): GitCommandKind {
  const { subcommand, rest } = splitSubcommand(args)
  if (!subcommand) return 'write'
  if (READ_SUBCOMMANDS.has(subcommand)) return 'read'
  if (NETWORK_SUBCOMMANDS.has(subcommand)) return 'network'
  const flags = rest.filter((arg) => arg.startsWith('-')).map(flagName)
  const positional = rest.filter((arg) => !arg.startsWith('-'))
  switch (subcommand) {
    case 'branch':
    case 'tag': {
      // `-a` lists all branches but annotates a tag; for a tag it is a write.
      const writes = flags.some((flag) => LIST_WRITE_FLAGS.has(flag) && !(subcommand === 'branch' && flag === '-a'))
      if (writes) return 'write'
      if (rest.length === 0) return 'read'
      return flags.some((flag) => LIST_FLAGS.has(flag)) ? 'read' : 'write'
    }
    case 'symbolic-ref':
      // `symbolic-ref HEAD` reads; `symbolic-ref HEAD refs/heads/x` and `-d` write.
      return positional.length <= 1 && !flags.includes('-d') && !flags.includes('--delete') ? 'read' : 'write'
    case 'stash':
      return positional[0] === 'list' || positional[0] === 'show' ? 'read' : 'write'
    case 'worktree':
      return positional[0] === 'list' ? 'read' : 'write'
    case 'remote':
      // Bare `remote`, `remote -v`, `remote get-url`. `remote update` fetches;
      // everything else edits config.
      if (positional.length === 0 || positional[0] === 'get-url') return 'read'
      if (positional[0] === 'update') return 'network'
      return 'write'
    case 'config':
      return flags.some((flag) => ['--get', '--get-all', '--get-regexp', '-l', '--list'].includes(flag))
        ? 'read'
        : 'write'
    default:
      return 'write'
  }
}

export function defaultGitTimeoutMs(kind: GitCommandKind): number | null {
  if (kind === 'read') return GIT_READ_TIMEOUT_MS
  if (kind === 'network') return GIT_NETWORK_TIMEOUT_MS
  return null
}

/**
 * The environment every git here runs with.
 *
 * LC_ALL=C pins git's messages to English: callers branch on stderr text
 * (e.g. "not fully merged" → force-delete escalation), which localized git
 * would silently break. Paths are bytes to git, so content is unaffected.
 *
 * GIT_TERMINAL_PROMPT=0 on every call: nothing here has a terminal, so a git
 * that decides to ask for a username (an https remote with no credential
 * helper) would otherwise wait on a prompt nobody can see, for ever. With it
 * set git fails at once with "terminal prompts disabled", which is the message
 * the person needs. A credential helper still runs; only the tty prompt is off.
 */
export function gitEnv(overrides?: NodeJS.ProcessEnv, kind: GitCommandKind = 'write'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(kind === 'read' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
    ...overrides,
  }
}

export type GitRunOptions = {
  /**
   * Overrides the deadline the command's kind would get; `null` means none.
   * Leave it out unless the call is known to be unusual.
   */
  timeoutMs?: number | null
  /** Overrides the classification, for a subcommand the classifier cannot see into. */
  kind?: GitCommandKind
}

type ExecGitResult = { stdout: string; stderr: string }
type ExecGitError = Error & { stdout?: string; stderr?: string; timedOut?: boolean }

/**
 * Counts every git process this module starts, by kind. Read by the spawn-rate
 * test and by nothing else; it costs an increment.
 */
export const gitSpawnCounter = { read: 0, network: 0, write: 0 }

// ── Repositories on another machine ─────────────────────────────────────────
//
// A repository that belongs to a WSL workspace is run by that distribution's
// git (owner decision 2026-09-24): its agents commit, branch and add worktrees
// with Linux git, and two gits on one repository disagree about worktree
// links, line endings and the index. The resolver says which host a folder is
// on; a WSL host runs the command inside the distribution under the same kind,
// deadline and environment rules as everything here. Everything else — every
// path on macOS and Linux, and a plain Windows folder — keeps the `execFile`
// below, untouched.

type GitHost = Pick<ExecutionHost, 'kind' | 'runGit'>
let gitHostResolver: ((cwd: string) => GitHost | null) | null = null

/** Installed by app-services once the host registry exists. */
export function installGitHostResolver(resolver: ((cwd: string) => GitHost | null) | null): void {
  gitHostResolver = resolver
}

/**
 * The variables `gitEnv` adds for git's own sake, plus the caller's, without
 * this process's whole environment: a git in WSL gets its environment from
 * its own login, and only what the runner decides crosses.
 */
function gitEnvDelta(overrides: NodeJS.ProcessEnv | undefined, kind: GitCommandKind): Record<string, string> {
  const delta: Record<string, string> = {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(kind === 'read' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  }
  for (const [key, value] of Object.entries(overrides ?? {})) if (typeof value === 'string') delta[key] = value
  return delta
}

async function execGitOnHost(
  host: GitHost,
  cwd: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv | undefined,
  kind: GitCommandKind,
  timeoutMs: number | null,
): Promise<ExecGitResult> {
  const outcome = await host.runGit(cwd, args, { timeoutMs, env: gitEnvDelta(envOverrides, kind) })
  if (outcome.code === 0 && !outcome.timedOut && !outcome.spawnFailed) {
    return { stdout: outcome.stdout, stderr: outcome.stderr }
  }
  const failure = new Error(
    outcome.timedOut
      ? `git ${splitSubcommand(args).subcommand ?? ''} did not finish within ${Math.round((timeoutMs ?? 0) / 1000)} s and was stopped.`
      : outcome.stderr.trim() || `git exited with code ${outcome.code}.`,
  ) as ExecGitError
  failure.stdout = outcome.stdout
  failure.stderr = outcome.timedOut ? '' : outcome.stderr
  if (outcome.timedOut) failure.timedOut = true
  throw failure
}

/**
 * One git process, with its kind's deadline. On POSIX a timed child is started
 * in its own process group so the deadline ends git and whatever it started (a
 * transport helper, a hook) together; see `killProcessTree`.
 */
function execGit(
  cwd: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv | undefined,
  options: GitRunOptions,
): Promise<ExecGitResult> {
  const kind = options.kind ?? classifyGitCommand(args)
  const timeoutMs = options.timeoutMs === undefined ? defaultGitTimeoutMs(kind) : options.timeoutMs
  const grouped = timeoutMs !== null && process.platform !== 'win32'
  gitSpawnCounter[kind] += 1

  const host = gitHostResolver?.(cwd) ?? null
  if (host && host.kind === 'wsl') return execGitOnHost(host, cwd, args, envOverrides, kind, timeoutMs)

  return new Promise((resolvePromise, reject) => {
    let timedOut = false
    let timer: NodeJS.Timeout | null = null
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env: gitEnv(envOverrides, kind),
        ...(grouped ? { detached: true } : {}),
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        if (!error && !timedOut) {
          resolvePromise({ stdout, stderr })
          return
        }
        const failure = (error ?? new Error('git was stopped.')) as ExecGitError
        failure.stdout = stdout
        failure.stderr = stderr
        if (timedOut) {
          const seconds = Math.round((timeoutMs ?? 0) / 1000)
          failure.timedOut = true
          failure.message = `git ${splitSubcommand(args).subcommand ?? ''} did not finish within ${seconds} s and was stopped.`
          failure.stderr = ''
        }
        reject(failure)
      },
    )
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child, { processGroup: grouped })
      }, timeoutMs)
    }
  })
}

export async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  const { stdout } = await execGit(cwd, args, undefined, options)
  return stdout
}

function removeLineEndingWarnings(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(
          line.trim(),
        ),
    )
    .join('\n')
    .trim()
}

export async function runGitCommand(
  cwd: string,
  args: string[],
  envOverrides?: NodeJS.ProcessEnv,
  options: GitRunOptions = {},
): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execGit(cwd, args, envOverrides, options)
    return { ok: true, stdout, stderr: removeLineEndingWarnings(stderr), message: null }
  } catch (error) {
    const execError = error as ExecGitError
    const stderr = removeLineEndingWarnings(execError.stderr ?? '')
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr,
      message: execError.timedOut
        ? execError.message
        : stderr || removeLineEndingWarnings(execError.message ?? '') || 'Git command failed.',
    }
  }
}
