// What a real WSL helper needs from the running app, and the helper client
// built on it for one distribution.
//
// app-services configures this once at startup (`configureWslHelpers`) with the
// app's version, its userData directory, where the helper's files ship, and
// the three things only the app can do with what the helper relays: validate
// an agent-state frame, connect an MCP channel to the automation server, and
// re-read CLI availability when a PATH directory changes. Tests and macOS never
// configure it; a WSL host there has no helper to start.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Duplex, Readable } from 'node:stream'

import { runSpawnDescriptor } from '../process-run'
import { createWslHelperClient, stageId, type WslHelperClient } from './wsl-helper-client'
import { wslExeRunner, type WslRunner } from './wsl-runner'
import { runWslScript, wslDistroArgs } from './wsl-distro'
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

const INSTALL_SCRIPT_TIMEOUT_MS = 3 * 60_000
const TAR_TIMEOUT_MS = 10 * 60_000

/**
 * Installs one tree into a distribution: staged, unpacked from `body` by
 * `tar`, then checked, marked and moved into place under the install lock.
 * Throws a `WslSetupError` naming what failed.
 */
export async function installTree(
  distro: string,
  input: {
    kind: 'node' | 'app' | 'server'
    digest: string
    argv: (id: string) => string[]
    body: () => Buffer | Readable
  },
  appVersion: string,
  runner: WslRunner = wslExeRunner,
): Promise<void> {
  const id = stageId()
  const what = input.kind === 'node' ? 'Node.js' : input.kind === 'server' ? 'the Studio server' : 'the helper'
  const staged = await runner.runScript(distro, buildStageScript(id), { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS })
  if (!staged.stdout.includes(STAGED_MARKER)) {
    throw new WslSetupError(
      `Couldn't set up WSL: could not prepare ~/${WSL_DATA_REL} in ${distro} (${(staged.stderr || staged.stdout).trim()}).`,
      { fatal: !staged.timedOut, code: 'install' },
    )
  }
  const unpacked = await runner.runExec(distro, input.argv(id), input.body(), TAR_TIMEOUT_MS)
  if (unpacked.code !== 0 || unpacked.timedOut) {
    throw new WslSetupError(
      `Couldn't set up WSL: unpacking ${what} in ${distro} failed (${unpacked.stderr.trim() || `exit ${unpacked.code}`}).`,
      { fatal: !unpacked.timedOut, code: 'install' },
    )
  }
  const committed = await runner.runScript(
    distro,
    buildCommitScript(
      input.kind === 'node'
        ? { kind: 'node', stageId: id, digest: input.digest }
        : { kind: input.kind, stageId: id, digest: input.digest, appVersion },
    ),
    { timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS },
  )
  if (!committed.stdout.includes(COMMITTED_MARKER)) {
    const reason = commitFailure(committed.stdout, committed.stderr)
    const nodeRun = /^node-(run|version)/u.test(reason)
    const serverRun = /^server-(run|version)/u.test(reason)
    throw new WslSetupError(
      nodeRun
        ? `Couldn't set up WSL: Node.js ${WSL_NODE_VERSION} does not run in ${distro} (${reason}). It needs glibc 2.28 or later.`
        : serverRun
          ? `Couldn't set up WSL: the Studio server does not load in ${distro} (${reason}).`
          : `Couldn't set up WSL: installing into ${distro} failed (${reason || `exit ${committed.code}`}).`,
      { fatal: !committed.timedOut, code: nodeRun || serverRun ? 'node-run' : 'install' },
    )
  }
}

/**
 * The pinned Node, into a distribution that has none (or a broken one): the
 * archive for its architecture, downloaded once into `cacheDir` and checked.
 */
export async function installNodeInto(
  distro: string,
  report: Pick<NeedReport, 'arch' | 'xz'>,
  options: {
    cacheDir: string
    appVersion: string
    fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
    log?: (message: string) => void
  },
  runner: WslRunner = wslExeRunner,
): Promise<void> {
  const arch = wslNodeArch(report.arch)
  if (!arch) {
    throw new WslSetupError(
      `Couldn't set up WSL: ${distro} runs on ${report.arch || 'an unknown processor'}, and the helper ships Node.js for x86_64 and arm64 only.`,
      { fatal: true, code: 'unsupported-arch' },
    )
  }
  const pkg = wslNodePackage(arch, report.xz ? 'xz' : 'gz')
  options.log?.(`Installing Node.js ${WSL_NODE_VERSION} (${pkg.fileName}) into ${distro}.`)
  const archive = await ensureWslNodeArchive(pkg, {
    cacheDir: options.cacheDir,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  await installTree(
    distro,
    { kind: 'node', digest: pkg.sha256, argv: (id) => tarArgs('node', id, pkg), body: () => createReadStream(archive) },
    options.appVersion,
    runner,
  )
}

/** The pinned Node archives' digests, any of which a Node ready marker may hold. */
export function wslNodeDigests(): string[] {
  return nodeDigests()
}

async function installInto(distro: string, report: NeedReport, env: WslHelperEnvironment): Promise<void> {
  if (report.node) {
    await installNodeInto(distro, report, {
      cacheDir: join(env.userDataDir, 'wsl-runtime'),
      appVersion: env.appVersion,
      ...(env.fetch ? { fetch: env.fetch } : {}),
      ...(env.log ? { log: env.log } : {}),
    })
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

/** What a WSL machine's chat, git or model list says where the WSL helper is not configured. */
const WSL_HELPER_UNAVAILABLE =
  "Couldn't set up WSL: the WSL helper does not run while Studio server is in its own process. " +
  'Turn off "Run Studio server in its own process" in Settings to use this machine.'

/**
 * The helper client for one distribution, wired to the running app. Throws a
 * `WslSetupError` from `start` when the app never configured helpers (tests,
 * or a platform without WSL).
 */
export function createDefaultWslHelperClient(distro: string): WslHelperClient {
  const env = () => {
    if (!environment) {
      // In the desktop's server out of process (the helper is the shell's),
      // or in tests. Out of process a WSL chat runs only where the person
      // turned on its distribution's Studio server.
      throw new WslSetupError(WSL_HELPER_UNAVAILABLE, {
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
      return wslExeRunner.spawnShell(distro)
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
