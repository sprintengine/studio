// What a real WSL helper needs from the running app, and the helper client
// built on it for one distribution.
//
// app-services configures this once at startup (`configureWslHelpers`) with the
// app's version, its userData directory, where the helper's files ship, and
// the three things only the app can do with what the helper relays: validate
// an agent-state frame, connect an MCP channel to the automation server, and
// re-read CLI availability when a PATH directory changes. Tests and macOS never
// configure it; a WSL host there has no helper to start.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Duplex, Readable } from 'node:stream'

import { killProcessTree } from '../process-tree-kill'
import { runSpawnDescriptor, type RunOutcome } from '../process-run'
import { createWslHelperClient, stageId, type HelperProcess, type WslHelperClient } from './wsl-helper-client'
import { decodeWslOutput, runWslScript, wslDistroArgs } from './wsl-distro'
import {
  buildAppPayload,
  buildCommitScript,
  buildLaunchScript,
  buildStageScript,
  buildUnreadyScript,
  COMMITTED_MARKER,
  commitFailure,
  STAGED_MARKER,
  tarArgs,
  WSL_DATA_REL,
  type AppPayload,
  type NeedReport,
} from './wsl-install'
import { ensureWslNodeArchive, wslNodeArch, wslNodePackage, WSL_NODE_VERSION } from './wsl-node-runtime'
import type { WslPluginSources } from './wsl-plugin-copy'
import { WslSetupError } from './wsl-setup-error'

export type WslHelperEnvironment = {
  appVersion: string
  userDataDir: string
  /** `resources/wsl-helper`, `resources/hooks` and `resources/automation` in this build. */
  resources: () => { helperDir: string; hooksDir: string; automationDir: string } | null
  /** What the plugin copy for a distribution is built from. */
  pluginSources: () => WslPluginSources
  /** The automation server's own socket; the only place an MCP channel goes. */
  automationSocketPath: () => string
  ingestAgentStateLine: (line: string) => void
  onPathsChanged: (distro: string) => void
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  log?: (message: string) => void
}

let environment: WslHelperEnvironment | null = null

export function configureWslHelpers(next: WslHelperEnvironment | null): void {
  environment = next
  payloadCache = null
}

export function wslHelperEnvironment(): WslHelperEnvironment | null {
  return environment
}

/** A profile's id for its socket directory: the same hash its own sockets use. */
export function wslProfileId(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

let payloadCache: AppPayload | null = null

function appPayload(env: WslHelperEnvironment): AppPayload {
  if (payloadCache) return payloadCache
  const dirs = env.resources()
  if (!dirs) {
    throw new WslSetupError("Couldn't set up WSL: this build shipped without the WSL helper.", {
      fatal: true,
      code: 'install',
    })
  }
  payloadCache = buildAppPayload([
    { dir: dirs.helperDir, into: 'wsl-helper', filter: (path) => path.endsWith('.mjs') },
    { dir: dirs.hooksDir, into: 'hooks', filter: (path) => path.endsWith('.mjs') && !path.includes('/') },
    { dir: dirs.automationDir, into: 'automation', filter: (path) => path === 'mcp-stdio-bridge.mjs' },
  ])
  return payloadCache
}

// The four pinned Node archives are all acceptable markers: which one was
// installed depends on the distribution's architecture and whether it has xz.
function nodeDigests(): string[] {
  return (['x64', 'arm64'] as const).flatMap((arch) =>
    (['xz', 'gz'] as const).map((compression) => wslNodePackage(arch, compression).sha256),
  )
}

/** Runs `wsl.exe -d <distro> --cd ~ --exec <argv>` with `body` streamed to its stdin. */
function runWslExec(
  distro: string,
  argv: readonly string[],
  body: Buffer | Readable,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', [...wslDistroArgs(distro), '--cd', '~', '--exec', ...argv], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: '', stderr: error.message, timedOut: false, spawnFailed: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: decodeWslOutput(Buffer.concat(out)),
        stderr: decodeWslOutput(Buffer.concat(err)),
        timedOut,
      })
    })
    if (Buffer.isBuffer(body)) child.stdin.end(body)
    else body.pipe(child.stdin)
  })
}

const INSTALL_SCRIPT_TIMEOUT_MS = 3 * 60_000
const TAR_TIMEOUT_MS = 10 * 60_000

async function installTree(
  distro: string,
  input: { kind: 'node' | 'app'; digest: string; argv: (id: string) => string[]; body: () => Buffer | Readable },
  appVersion: string,
): Promise<void> {
  const id = stageId()
  const staged = await runWslScript(distro, buildStageScript(id), { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS })
  if (!staged.stdout.includes(STAGED_MARKER)) {
    throw new WslSetupError(
      `Couldn't set up WSL: could not prepare ~/${WSL_DATA_REL} in ${distro} (${(staged.stderr || staged.stdout).trim()}).`,
      { fatal: !staged.timedOut, code: 'install' },
    )
  }
  const unpacked = await runWslExec(distro, input.argv(id), input.body(), TAR_TIMEOUT_MS)
  if (unpacked.code !== 0 || unpacked.timedOut) {
    throw new WslSetupError(
      `Couldn't set up WSL: unpacking ${input.kind === 'node' ? 'Node.js' : 'the helper'} in ${distro} failed (${unpacked.stderr.trim() || `exit ${unpacked.code}`}).`,
      { fatal: !unpacked.timedOut, code: 'install' },
    )
  }
  const committed = await runWslScript(
    distro,
    buildCommitScript(
      input.kind === 'node'
        ? { kind: 'node', stageId: id, digest: input.digest }
        : { kind: 'app', stageId: id, digest: input.digest, appVersion },
    ),
    { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS },
  )
  if (!committed.stdout.includes(COMMITTED_MARKER)) {
    const reason = commitFailure(committed.stdout, committed.stderr)
    const nodeRun = /^node-(run|version)/u.test(reason)
    throw new WslSetupError(
      nodeRun
        ? `Couldn't set up WSL: Node.js ${WSL_NODE_VERSION} does not run in ${distro} (${reason}). It needs glibc 2.28 or later.`
        : `Couldn't set up WSL: installing into ${distro} failed (${reason || `exit ${committed.code}`}).`,
      { fatal: !committed.timedOut, code: nodeRun ? 'node-run' : 'install' },
    )
  }
}

async function installInto(distro: string, report: NeedReport, env: WslHelperEnvironment): Promise<void> {
  if (report.node) {
    const arch = wslNodeArch(report.arch)
    if (!arch) {
      throw new WslSetupError(
        `Couldn't set up WSL: ${distro} runs on ${report.arch || 'an unknown processor'}, and the helper ships Node.js for x86_64 and arm64 only.`,
        { fatal: true, code: 'unsupported-arch' },
      )
    }
    const pkg = wslNodePackage(arch, report.xz ? 'xz' : 'gz')
    env.log?.(`Installing Node.js ${WSL_NODE_VERSION} (${pkg.fileName}) into ${distro}.`)
    const archive = await ensureWslNodeArchive(pkg, {
      cacheDir: join(env.userDataDir, 'wsl-runtime'),
      ...(env.fetch ? { fetch: env.fetch } : {}),
    })
    await installTree(
      distro,
      {
        kind: 'node',
        digest: pkg.sha256,
        argv: (id) => tarArgs('node', id, pkg),
        body: () => createReadStream(archive),
      },
      env.appVersion,
    )
  }
  if (report.app) {
    const payload = appPayload(env)
    env.log?.(`Installing the helper for ${env.appVersion} into ${distro}.`)
    await installTree(
      distro,
      { kind: 'app', digest: payload.digest, argv: (id) => tarArgs('app', id), body: () => payload.tarGz },
      env.appVersion,
    )
  }
}

function spawnShell(distro: string): HelperProcess {
  const child = spawn('wsl.exe', [...wslDistroArgs(distro), '--cd', '~', '--exec', 'sh', '-s'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => undefined)
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => killProcessTree(child),
    once: (event: 'close' | 'error', listener: (...args: never[]) => void) =>
      child.once(event, listener as (...args: unknown[]) => void),
  } as HelperProcess
}

/**
 * The helper client for one distribution, wired to the running app. Throws a
 * `WslSetupError` from `start` when the app never configured helpers (tests,
 * or a platform without WSL).
 */
export function createDefaultWslHelperClient(distro: string): WslHelperClient {
  const env = () => {
    if (!environment) {
      throw new WslSetupError("Couldn't set up WSL: the WSL helper is not available in this process.", {
        fatal: true,
        code: 'start',
      })
    }
    return environment
  }
  return createWslHelperClient({
    distro,
    get appVersion() {
      return environment?.appVersion ?? '0.0.0'
    },
    get profile() {
      return environment ? wslProfileId(environment.userDataDir) : 'none'
    },
    spawnShell: () => {
      env()
      return spawnShell(distro)
    },
    launchScript: async () => {
      const current = env()
      return buildLaunchScript({
        appVersion: current.appVersion,
        nodeDigests: nodeDigests(),
        appDigest: appPayload(current).digest,
        profile: wslProfileId(current.userDataDir),
      })
    },
    install: (report) => installInto(distro, report, env()),
    prewarm: async () => {
      await runSpawnDescriptor(
        { file: 'wsl.exe', args: [...wslDistroArgs(distro), '--exec', 'true'] },
        { timeoutMs: 60_000 },
      )
    },
    unready: async (what) => {
      const lines = [
        ...(what.node ? [buildUnreadyScript()] : []),
        ...(what.app ? [`rm -f "$HOME/${WSL_DATA_REL}/${env().appVersion}/.ready"`] : []),
      ]
      if (lines.length > 0) await runWslScript(distro, lines.join('\n'), { timeoutMs: 30_000 })
    },
    onEvent: (event) => {
      const current = environment
      if (!current) return
      if (event.event === 'agentState') current.ingestAgentStateLine(event.line)
      else current.onPathsChanged(distro)
    },
    connectAutomation: (): Duplex => connect({ path: env().automationSocketPath(), allowHalfOpen: true }),
    log: (message) => environment?.log?.(message),
  })
}
