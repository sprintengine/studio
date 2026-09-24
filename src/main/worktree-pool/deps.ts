import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { delimiter, join } from 'path'
import { killProcessTree } from '../process-tree-kill'

/**
 * A pool slot's installed dependencies, and when they have to be installed
 * again.
 *
 * A slot keeps its ignored files across refreshes (`clean -fd`, never `-x`),
 * so `node_modules` survives a reset and is reused as long as it still matches
 * the tree. "Matches" is the fingerprint: a hash over the lockfile, the install
 * command, the package manager's and Node's versions, and the platform and
 * architecture. Any of those moving means the installed tree may no longer be
 * what the lockfile asks for, and the install runs again, in the background,
 * before the slot is offered to an agent.
 */

export type InstallPlan = {
  /** The lockfile the command installs from, relative to the slot. */
  lockfile: string
  /** The binary, looked up on the login PATH. */
  command: string
  args: string[]
  /** How the plan is shown: `npm ci`. */
  display: string
  /** The binary whose `--version` goes into the fingerprint. */
  versionOf: string
}

// First match wins. A repository carrying two lockfiles is rare and usually
// mid-migration; the stricter, newer manager is the likelier truth.
const PLANS: InstallPlan[] = [
  {
    lockfile: 'pnpm-lock.yaml',
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    display: 'pnpm install --frozen-lockfile',
    versionOf: 'pnpm',
  },
  {
    lockfile: 'bun.lock',
    command: 'bun',
    args: ['install'],
    display: 'bun install',
    versionOf: 'bun',
  },
  {
    lockfile: 'bun.lockb',
    command: 'bun',
    args: ['install'],
    display: 'bun install',
    versionOf: 'bun',
  },
  {
    lockfile: 'yarn.lock',
    command: 'yarn',
    args: ['install', '--frozen-lockfile'],
    display: 'yarn install --frozen-lockfile',
    versionOf: 'yarn',
  },
  {
    lockfile: 'package-lock.json',
    command: 'npm',
    args: ['ci'],
    display: 'npm ci',
    versionOf: 'npm',
  },
]

/** The install a slot's tree asks for, read off the lockfile at its root; null when there is none. */
export async function detectInstallPlan(slotPath: string): Promise<{ plan: InstallPlan; lockfile: Buffer } | null> {
  for (const plan of PLANS) {
    const content = await readFile(join(slotPath, plan.lockfile)).catch(() => null)
    if (content) return { plan, lockfile: content }
  }
  return null
}

export function depsFingerprint(input: {
  lockfile: Buffer
  plan: InstallPlan
  managerVersion: string | null
  nodeVersion: string | null
  platform: string
  arch: string
}): string {
  return createHash('sha256')
    .update(input.plan.lockfile)
    .update('\0')
    .update(input.lockfile)
    .update('\0')
    .update(input.plan.display)
    .update('\0')
    .update(input.managerVersion ?? '?')
    .update('\0')
    .update(input.nodeVersion ?? '?')
    .update('\0')
    .update(`${input.platform}-${input.arch}`)
    .digest('hex')
}

export type ToolRunResult = { code: number | null; output: string; timedOut: boolean }

export type ToolRunner = (input: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}) => Promise<ToolRunResult>

const OUTPUT_TAIL_BYTES = 4_000

/**
 * Run a package manager. Its stdin is closed, so nothing can wait on a
 * question; its output is kept only as a tail, for the failure message. On
 * Windows the managers are `.cmd` shims, which only a shell starts.
 */
export const defaultToolRunner: ToolRunner = ({ command, args, cwd, env, timeoutMs, signal }) =>
  new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const windows = process.platform === 'win32'
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: windows,
      ...(windows ? {} : { detached: true }),
    })
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const stop = (): void => killProcessTree(child, { processGroup: !windows })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = (): void => stop()
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, output: output.trim(), timedOut })
    }
    child.on('error', (error) => {
      output = `${output}\n${error.message}`.trim()
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

export const INSTALL_TIMEOUT_MS = 20 * 60_000
const VERSION_TIMEOUT_MS = 15_000
const VERSION_CACHE_MS = 10 * 60_000

export type DepsEnvironment = {
  /** The environment an install runs with: the person's login PATH in front. */
  env(): Promise<NodeJS.ProcessEnv>
  /** `<binary> --version`, cached for a while; null when it will not run. */
  version(binary: string): Promise<string | null>
}

export function createDepsEnvironment(deps: {
  resolveLoginPath: (env: NodeJS.ProcessEnv) => Promise<string | null>
  run?: ToolRunner
  now?: () => number
}): DepsEnvironment {
  const run = deps.run ?? defaultToolRunner
  const now = deps.now ?? Date.now
  const versions = new Map<string, { at: number; value: Promise<string | null> }>()

  const env = async (): Promise<NodeJS.ProcessEnv> => {
    const base = { ...process.env }
    const loginPath = await deps.resolveLoginPath(base).catch(() => null)
    const merged = [loginPath, base.PATH].filter(Boolean).join(delimiter)
    // Running inside the app's own Electron must not leak into a child `node`:
    // with this set, `node` would behave as Electron's embedded one.
    delete base.ELECTRON_RUN_AS_NODE
    return { ...base, PATH: merged }
  }

  return {
    env,
    version(binary) {
      const cached = versions.get(binary)
      if (cached && now() - cached.at < VERSION_CACHE_MS) return cached.value
      const value = env().then(async (environment) => {
        const result = await run({
          command: binary,
          args: ['--version'],
          cwd: process.cwd(),
          env: environment,
          timeoutMs: VERSION_TIMEOUT_MS,
        })
        if (result.code !== 0) return null
        return result.output.split(/\r?\n/u)[0]?.trim() || null
      })
      versions.set(binary, { at: now(), value })
      return value
    },
  }
}
