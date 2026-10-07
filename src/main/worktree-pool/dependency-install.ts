import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

import type {
  WorktreeDependencyInstallReason,
  WorktreeDependencyInstallSetting,
  WorktreeDependencyInstallView,
} from '../../shared/ipc/worktree-pool'
import { ansiPlainText } from '../../shared/conversation/ansi'
import { killProcessTree } from '../process-tree-kill'

/**
 * A leased pool worktree installs its dependencies when its lockfile changed
 * since it last did (owner ruling 2026-10-06, revising "no installs, ever").
 *
 * The pool itself stays install-free: it resets a slot and hands it out, and
 * this runs after, in the one place every agent worktree is made
 * (`createAgentWorktreeFromPool` in git.ts), so New chat, the tab strip's
 * worktree spawn, `agent.launch` and scheduled runs all wait for it the same
 * way. The agent starts once it ends, whether or not it worked: a failed
 * install is reported, never a reason to withhold the chat.
 *
 * Off unless the project opted in, because an install runs the repository's
 * own scripts (`postinstall` and the like) with the person's rights.
 *
 * What a slot last installed is recorded in its git admin directory
 * (`.git/worktrees/<slot>/`), not in the pool's record and not in the
 * worktree: `clean -fd` and "Clear ignored files" never reach it, git ignores
 * a file it does not know there, and it lives exactly as long as the slot is
 * registered — a slot removed and made again starts with no record, as it
 * starts with no `node_modules`. The record is a fingerprint of the command
 * and the lockfiles it reads; it is cleared before an install starts and
 * written only when one succeeds, so an install that failed, timed out or was
 * cancelled runs again at the next lease.
 */

/** The lockfiles an install command is inferred from, in the order a tie is broken. */
const JS_LOCKFILES = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock', 'package-lock.json'] as const

/**
 * Other ecosystems' lockfiles. Nothing is inferred from them, but a project's
 * own command may read any of them, so under one every lockfile present
 * counts toward whether it runs.
 */
const OTHER_LOCKFILES = ['Cargo.lock', 'uv.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'] as const

/** Where a slot's install record lives, in its git admin directory. */
export const DEPENDENCY_INSTALL_RECORD = 'sprintengine-dependencies.json'

/** Long enough for a cold native rebuild; a hung script is still let go of. */
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 20 * 60_000

/** How often a running install's last line is sent to the windows. */
const PROGRESS_INTERVAL_MS = 750

/** The end of an install's output kept for a failure's report. */
const OUTPUT_TAIL_CHARS = 8_000

/** How long after the install exits its pipes may stay open (a daemon a script left behind). */
const PIPE_DRAIN_GRACE_MS = 2_000

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const MANAGER_OF: Record<(typeof JS_LOCKFILES)[number], PackageManager> = {
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
}

/**
 * The install a JavaScript project's lockfile implies, never one that rewrites
 * the lockfile: a slot's tracked files must stay as the reset left them.
 *
 * Several lockfiles at once happen (a stale `package-lock.json` beside the
 * `yarn.lock` in use); `packageManager` in package.json settles it when it
 * names a manager whose lockfile is there, else the order above does. Yarn 2
 * and later (`packageManager: yarn@2+`, or a `.yarnrc.yml`) spell the frozen
 * install `--immutable`.
 */
export function inferInstallCommand(input: {
  files: ReadonlySet<string>
  packageManager?: string | null
}): { lockfile: string; command: string } | null {
  const present = JS_LOCKFILES.filter((name) => input.files.has(name))
  if (present.length === 0) return null
  const declared = /^(npm|pnpm|yarn|bun)@(\d+)?/u.exec(input.packageManager?.trim() ?? '')
  const lockfile = present.find((name) => MANAGER_OF[name] === declared?.[1]) ?? present[0]
  switch (MANAGER_OF[lockfile]) {
    case 'pnpm':
      return { lockfile, command: 'pnpm install --frozen-lockfile' }
    case 'bun':
      return { lockfile, command: 'bun install --frozen-lockfile' }
    case 'yarn': {
      const major = declared?.[1] === 'yarn' && declared[2] ? Number(declared[2]) : null
      const berry = major !== null ? major >= 2 : input.files.has('.yarnrc.yml')
      return { lockfile, command: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' }
    }
    case 'npm':
      return { lockfile, command: 'npm ci' }
  }
}

export type DependencyInstallPlan =
  | { run: false; why: 'off' | 'nothing-to-install' | 'up-to-date' }
  | { run: true; command: string; fingerprint: string; reason: WorktreeDependencyInstallReason }

type InstallRecord = { fingerprint: string; command: string; installedAt: number }

/**
 * The git admin directory of a worktree, read from its `.git` file
 * (`gitdir: …`, relative under `worktree.useRelativePaths`), or null.
 */
export async function worktreeGitDir(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, '.git')
  const info = await stat(dotGit).catch(() => null)
  if (!info) return null
  if (info.isDirectory()) return dotGit
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const match = /^gitdir:\s*(.+?)\s*$/mu.exec(text)
  return match ? resolve(worktreePath, match[1]) : null
}

async function readRecord(recordPath: string | null): Promise<InstallRecord | null> {
  if (!recordPath) return null
  const text = await readFile(recordPath, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const value = JSON.parse(text) as Partial<InstallRecord>
    return typeof value.fingerprint === 'string'
      ? { fingerprint: value.fingerprint, command: String(value.command ?? ''), installedAt: Number(value.installedAt) }
      : null
  } catch {
    return null
  }
}

/**
 * Whether a leased worktree should install, and with what. Runs when the
 * project opted in, there is something to run, and the worktree never
 * installed, installed with another lockfile or command, or lost what it
 * installed — a JavaScript project with neither `node_modules` nor Yarn's
 * Plug'n'Play map.
 */
export async function planDependencyInstall(input: {
  worktreePath: string
  setting: WorktreeDependencyInstallSetting | null
  recordPath: string | null
}): Promise<DependencyInstallPlan> {
  if (!input.setting?.enabled) return { run: false, why: 'off' }
  const files = new Set(await readdir(input.worktreePath).catch(() => [] as string[]))
  const packageManager = files.has('package.json')
    ? await readFile(join(input.worktreePath, 'package.json'), 'utf8')
        .then((text) => {
          const value = JSON.parse(text) as { packageManager?: unknown }
          return typeof value.packageManager === 'string' ? value.packageManager : null
        })
        .catch(() => null)
    : null
  const inferred = inferInstallCommand({ files, packageManager })
  const own = input.setting.command?.trim() || null
  const command = own ?? inferred?.command ?? null
  if (!command) return { run: false, why: 'nothing-to-install' }

  // The lockfile the inferred command reads; under a command of the project's
  // own, every lockfile there, since nothing says which it reads.
  const read = own
    ? [...JS_LOCKFILES, ...OTHER_LOCKFILES].filter((name) => files.has(name)).sort()
    : [inferred!.lockfile]
  const hash = createHash('sha256').update(`${command}\0`)
  for (const name of read) {
    const content = await readFile(join(input.worktreePath, name)).catch(() => null)
    hash.update(`${name}\0`)
    hash.update(content ?? '\0missing')
    hash.update('\0')
  }
  const fingerprint = hash.digest('hex')

  const record = await readRecord(input.recordPath)
  const javascript = JS_LOCKFILES.some((name) => files.has(name))
  const installed = !javascript || files.has('node_modules') || files.has('.pnp.cjs')
  if (!record) return { run: true, command, fingerprint, reason: 'first' }
  if (record.fingerprint !== fingerprint) return { run: true, command, fingerprint, reason: 'changed' }
  if (!installed) return { run: true, command, fingerprint, reason: 'missing' }
  return { run: false, why: 'up-to-date' }
}

export type InstallRunOutcome = {
  code: number | null
  timedOut: boolean
  cancelled: boolean
  /** Set when the command could not be started at all. */
  error?: string
}

export type InstallCommandRunner = (input: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onOutput: (chunk: string) => void
}) => Promise<InstallRunOutcome>

/**
 * The command through the platform's shell (`/bin/sh`, `cmd.exe`), so a
 * project's own command may chain steps and `npm` resolves as the `.cmd` shim
 * it is on Windows. Detached on POSIX so a timeout or a cancel ends the
 * scripts the manager started, not only the manager.
 */
export const runInstallCommand: InstallCommandRunner = ({ command, cwd, env, timeoutMs, signal, onOutput }) =>
  new Promise((done) => {
    let settled = false
    let timedOut = false
    let cancelled = false
    let drain: ReturnType<typeof setTimeout> | null = null
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stop = () => killProcessTree(child, { processGroup: true })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (outcome: InstallRunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drain) clearTimeout(drain)
      signal.removeEventListener('abort', onAbort)
      done(outcome)
    }
    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk.toString()))
    child.on('error', (error) => settle({ code: null, timedOut, cancelled, error: error.message }))
    child.on('exit', (code) => {
      drain = setTimeout(() => settle({ code, timedOut, cancelled }), PIPE_DRAIN_GRACE_MS)
    })
    child.on('close', (code) => settle({ code, timedOut, cancelled }))
    if (signal.aborted) onAbort()
  })

/** The last non-empty line of some output, as a terminal would leave it. */
function lastLineOf(text: string): string | null {
  const lines = ansiPlainText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1]
  return last ? last.slice(0, 300) : null
}

export type DependencyInstallerDeps = {
  /** The environment an install runs with: the person's PATH, the app's own variables left out. */
  env: () => Promise<NodeJS.ProcessEnv>
  run?: InstallCommandRunner
  /** Sent as an install starts, while it runs, and as it ends. */
  onChange?: (view: WorktreeDependencyInstallView) => void
  gitDir?: (worktreePath: string) => Promise<string | null>
  now?: () => number
  timeoutMs?: number
  log?: (line: string) => void
}

export type DependencyInstallInput = {
  repoRoot: string
  path: string
  branch: string
  setting: WorktreeDependencyInstallSetting | null
}

export type DependencyInstaller = ReturnType<typeof createDependencyInstaller>

export function createDependencyInstaller(deps: DependencyInstallerDeps) {
  const run = deps.run ?? runInstallCommand
  const gitDir = deps.gitDir ?? worktreeGitDir
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? DEPENDENCY_INSTALL_TIMEOUT_MS
  const log = deps.log ?? ((line: string) => console.info(`[worktree-install] ${line}`))
  const running = new Map<string, { view: WorktreeDependencyInstallView; abort: AbortController }>()

  /**
   * Install in a just-leased worktree if it needs it, and wait for it. Null
   * when nothing ran. Never throws: whatever happens here, the lease stands.
   */
  async function prepare(input: DependencyInstallInput): Promise<WorktreeDependencyInstallView | null> {
    const adminDir = await gitDir(input.path).catch(() => null)
    const recordPath = adminDir ? join(adminDir, DEPENDENCY_INSTALL_RECORD) : null
    const plan = await planDependencyInstall({ worktreePath: input.path, setting: input.setting, recordPath }).catch(
      (error: unknown) => {
        log(`${input.path}: could not tell whether to install: ${error instanceof Error ? error.message : error}`)
        return { run: false, why: 'nothing-to-install' } as const
      },
    )
    if (!plan.run) {
      if (plan.why !== 'off') log(`${input.path}: no install (${plan.why})`)
      return null
    }

    // Cleared first: from here until it succeeds, the slot has not installed.
    if (recordPath) await rm(recordPath, { force: true }).catch(() => {})

    const view: WorktreeDependencyInstallView = {
      id: randomUUID(),
      repoRoot: input.repoRoot,
      path: input.path,
      branch: input.branch,
      command: plan.command,
      reason: plan.reason,
      state: 'running',
      startedAt: now(),
      endedAt: null,
      lastLine: null,
      output: null,
      exitCode: null,
    }
    const abort = new AbortController()
    running.set(view.id, { view, abort })
    const emit = () => deps.onChange?.({ ...view })
    log(`${input.path}: ${plan.command} (${plan.reason})`)
    emit()

    let output = ''
    let pending: ReturnType<typeof setTimeout> | null = null
    const onOutput = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS)
      view.lastLine = lastLineOf(output) ?? view.lastLine
      pending ??= setTimeout(() => {
        pending = null
        if (view.state === 'running') emit()
      }, PROGRESS_INTERVAL_MS)
    }

    let outcome: InstallRunOutcome
    try {
      outcome = await run({
        command: plan.command,
        cwd: input.path,
        env: await deps.env(),
        timeoutMs,
        signal: abort.signal,
        onOutput,
      })
    } catch (error) {
      outcome = {
        code: null,
        timedOut: false,
        cancelled: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (pending) clearTimeout(pending)
      running.delete(view.id)
    }

    view.endedAt = now()
    view.exitCode = outcome.code
    view.state = outcome.cancelled
      ? 'cancelled'
      : outcome.timedOut
        ? 'timed-out'
        : outcome.code === 0 && !outcome.error
          ? 'succeeded'
          : 'failed'
    if (view.state === 'succeeded') {
      if (recordPath) {
        const record: InstallRecord = { fingerprint: plan.fingerprint, command: plan.command, installedAt: now() }
        await writeFile(recordPath, `${JSON.stringify(record)}\n`).catch((error: unknown) =>
          log(`${input.path}: installed, but could not record it: ${error instanceof Error ? error.message : error}`),
        )
      }
    } else {
      view.output = [ansiPlainText(output).trim(), outcome.error].filter(Boolean).join('\n') || null
    }
    log(`${input.path}: ${plan.command} ${view.state} in ${Math.round((view.endedAt - view.startedAt) / 1000)} s`)
    emit()
    return { ...view }
  }

  /** Stop a running install; the agent then starts as after a failed one. */
  function cancel(id: string): boolean {
    const entry = running.get(id)
    if (!entry) return false
    entry.abort.abort()
    return true
  }

  /** The installs running now, for a window that opens while one does. */
  function list(): WorktreeDependencyInstallView[] {
    return [...running.values()].map((entry) => ({ ...entry.view }))
  }

  return { prepare, cancel, list }
}

let active: DependencyInstaller | null = null

/** The installer leased worktrees go through (the desktop's main); none elsewhere. */
export function installDependencyInstaller(installer: DependencyInstaller | null): void {
  active = installer
}

export function activeDependencyInstaller(): DependencyInstaller | null {
  return active
}
