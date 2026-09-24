// One WSL distribution, as a machine of its own ("WSL: Ubuntu").
//
// Everything this host answers comes from the helper that lives in the
// distribution (`resources/wsl-helper/`), over the one `wsl.exe` stdio channel
// its client holds (`wsl-helper-client.ts`): process reads for the reaper, the
// survivor kill, CLI detection, the home folder, running a program, and git.
// Anything that needs the host starts the helper first if it is stopped, and a
// launch waits for that. There is no second path: when the helper cannot
// start, the host says why (`WslSetupError`) and the launch fails with that
// reason.
//
// The one thing still started without the helper is the terminal itself: its
// pty is `wsl.exe -d <distro> -e bash -li <startup script>` (terminal-launch),
// because that is what gives the agent a real terminal. The startup script
// carries the agent's identity and the helper's socket as `export` lines.

import type { CliDetectResult, CliRuntimeSettings } from '../../shared/electron-api'
import {
  executionHostLabel,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostState,
  type ExecutionHostSummary,
} from '../../shared/execution-host'
import { isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'
import { cliProbeRequest, detectResultFromHelper, type HelperProbeAnswer } from '../cli-runtime-install'
import type { RunOutcome } from '../process-run'
import type { SubtreeLiveReason } from '../terminal-subtree-probe'
import type {
  ExecutionHost,
  HostAgentIntegration,
  HostHome,
  HostProcessRef,
  HostSettingsReader,
} from './execution-host'
import { wslSessionPidKey, type WslDistro } from './wsl-distro'
import type { WslHelperClient, WslHelperInfo } from './wsl-helper-client'
import { createDefaultWslHelperClient, wslHelperEnvironment } from './wsl-helper-runtime'
import { buildWslPluginCopy, WSL_PLUGIN_TREE, type WslPluginCopy } from './wsl-plugin-copy'

/**
 * A git argument as Linux git reads it: a native absolute path (a worktree to
 * add, a `--git-dir=`) becomes the path in the distribution; everything else —
 * subcommands, flags, refs, relative pathspecs — is untouched.
 */
export function wslGitArg(arg: string): string {
  if (isWindowsPath(arg)) return toWslPath(arg)
  const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
  if (equals > 0 && isWindowsPath(arg.slice(equals + 1))) {
    return `${arg.slice(0, equals + 1)}${toWslPath(arg.slice(equals + 1))}`
  }
  return arg
}

/**
 * Git's answer with the absolute paths it printed put back into native form, so
 * a caller comparing `rev-parse --show-toplevel` or a worktree list against the
 * workspace folder sees the same spelling Windows git would have printed.
 * Porcelain status and diffs print paths relative to the repository and are
 * left alone.
 */
export function nativeGitOutput(args: readonly string[], stdout: string, distro: string): string {
  const subcommand = args.find((arg) => !arg.startsWith('-'))
  const toNative = (path: string) => wslToWindowsPath(path, { distro, separator: '/' })
  if (subcommand === 'rev-parse') {
    return stdout
      .split('\n')
      .map((line) => (line.startsWith('/') ? toNative(line) : line))
      .join('\n')
  }
  if (subcommand === 'worktree') {
    return stdout
      .split('\n')
      .map((line) => {
        if (line.startsWith('worktree /')) return `worktree ${toNative(line.slice('worktree '.length))}`
        // The human listing: the path, then the head and the branch.
        const match = /^(\/\S*)(\s.*)?$/u.exec(line)
        return match ? `${toNative(match[1])}${match[2] ?? ''}` : line
      })
      .join('\n')
  }
  return stdout
}

/** The state a distribution's `wsl --list` row reports, as a host state. */
export function wslHostState(distro: WslDistro | undefined): { state: ExecutionHostState; reason?: string } {
  if (!distro) return { state: 'unavailable', reason: 'This distribution is not installed.' }
  const state = distro.state.toLowerCase()
  if (state === 'running') return { state: 'ready' }
  // A stopped distribution is still usable: the first process started in it
  // boots it, which takes a second or two.
  if (state === 'stopped') return { state: 'stopped' }
  return { state: 'starting', reason: `WSL reports it as ${distro.state}.` }
}

export type WslHostDeps = {
  readSettings: HostSettingsReader
  /** What the last `wsl --list` said about this distribution; undefined when it was not listed. */
  listed: () => WslDistro | undefined
  /** The helper client; tests pass a stand-in. Absent is the real one. */
  helper?: WslHelperClient
  /** The plugin copy for a running helper; tests pass a stand-in. */
  buildPluginCopy?: (info: WslHelperInfo) => Promise<WslPluginCopy | null>
  /** How long the survivor kill waits for a killed pty's children to go on their own. */
  survivorDelayMs?: number
}

type HelperRunOutcome = RunOutcome & { truncated?: boolean }

// The helper enforces a deadline itself; this is how much longer main waits
// for its answer before giving up on it.
const ANSWER_SLACK_MS = 10_000
const SNAPSHOT_TIMEOUT_MS = 20_000
const DETECT_TIMEOUT_MS = 60_000

function failedRun(error: unknown): RunOutcome {
  return {
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false,
    spawnFailed: true,
  }
}

function defaultPluginCopy(info: WslHelperInfo): Promise<WslPluginCopy | null> {
  const env = wslHelperEnvironment()
  if (!env) return Promise.resolve(null)
  return buildWslPluginCopy(env.pluginSources(), {
    nodeCommand: info.nodePath,
    appDir: info.appDir,
    userDataDir: info.userDataDir,
    agentStateSocketPath: info.agentSocket,
  })
}

export function createWslHost(distro: string, deps: WslHostDeps): ExecutionHost {
  const id: ExecutionHostId = wslHostId(distro)
  const helper = deps.helper ?? createDefaultWslHelperClient(distro)
  const buildPluginCopy = deps.buildPluginCopy ?? defaultPluginCopy
  const survivorDelayMs = deps.survivorDelayMs ?? 2_000
  const settings = () => deps.readSettings(id)
  const toNativePath = (hostPath: string) => wslToWindowsPath(hostPath, { distro })

  // Per running helper: what `home` said, and the plugin copy it holds.
  let prepared: { info: WslHelperInfo; home: HostHome; plugin: WslPluginCopy | null } | null = null
  let preparing: Promise<void> | null = null

  async function readHome(): Promise<HostHome> {
    const answer = await helper.request<{ home: string; env?: Record<string, string> }>('home')
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(answer.env ?? {})) {
      if (typeof value === 'string' && value.startsWith('/')) env[name] = toNativePath(value)
    }
    return { host: answer.home, native: toNativePath(answer.home), env }
  }

  async function ensurePluginCopy(info: WslHelperInfo): Promise<WslPluginCopy | null> {
    const copy = await buildPluginCopy(info).catch(() => null)
    if (!copy) return null
    const status = await helper.request<{ current: boolean }>('files.ensureTree', {
      name: WSL_PLUGIN_TREE,
      digest: copy.digest,
    })
    if (!status.current) {
      await helper.request('files.ensureTree', { name: WSL_PLUGIN_TREE, digest: copy.digest, files: copy.files })
    }
    return copy
  }

  async function prepare(): Promise<void> {
    const info = await helper.start()
    if (prepared?.info === info) return
    if (!preparing) {
      preparing = (async () => {
        const home = await readHome()
        // The copy is what lets a WSL Claude take `--plugin-dir`; without it
        // that CLI falls back to the workspace install, so a failure here is
        // not the launch's failure.
        const plugin = await ensurePluginCopy(info).catch(() => null)
        if (helper.info() === info) prepared = { info, home, plugin }
      })().finally(() => {
        preparing = null
      })
    }
    await preparing
  }

  function integration(): HostAgentIntegration | null {
    const info = helper.info()
    if (!info || !prepared || prepared.info !== info) return null
    return {
      agentStateSocketPath: info.agentSocket,
      commandRuntime: { executable: info.nodePath, toCommandPath: (nativePath) => toWslPath(nativePath) },
      pluginDirs: prepared.plugin?.pluginDirs ?? [],
      statusLineScriptPath: prepared.plugin?.statusLineScriptPath ?? null,
      studioMcpEntry: {
        command: info.nodePath,
        args: [`${info.appDir}/automation/mcp-stdio-bridge.mjs`],
        // Linux Node ignores ELECTRON_RUN_AS_NODE. It stays because it is how the
        // workspace tidy recognises this entry as the app's own gateway
        // (`removeManagedStudioGatewayFromClaudeWorkspace`), on any machine.
        env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: info.userDataDir },
      },
      home: prepared.home,
    }
  }

  return {
    id,
    kind: 'wsl',
    pathStyle: 'wsl',
    summary(): ExecutionHostSummary {
      const listed = deps.listed()
      const failure = helper.lastError()
      return {
        id,
        kind: 'wsl',
        label: executionHostLabel(id, 'win32'),
        pathStyle: 'wsl',
        ...(failure ? { state: 'unavailable' as const, reason: failure.message } : wslHostState(listed)),
        isDefaultDistro: listed?.isDefault ?? false,
        enabled: settings()?.enabled === true,
        wslVersion: listed?.version ?? null,
      }
    },
    toHostPath: (nativePath) => toWslPath(nativePath),
    toNativePath,
    async homeDir() {
      try {
        await prepare()
        return prepared?.home ?? (await readHome())
      } catch {
        return null
      }
    },
    prepare,
    retainSession: (leaseId) => helper.retain(leaseId),
    releaseSession: (leaseId) => helper.release(leaseId),
    agentIntegration: integration,
    launchTarget() {
      const own = settings()
      return {
        kind: 'wsl',
        distro,
        env: own?.env ?? {},
        ...(own?.shell ? { shell: own.shell } : {}),
        integration: integration(),
      }
    },
    cliRuntime(cli, runtime): CliRuntimeSettings {
      return {
        command: (settings()?.cliCommands[cli] ?? '').trim(),
        ...(runtime?.models ? { models: runtime.models } : {}),
        hostId: id,
      }
    },
    async probeSubtrees(refs: readonly HostProcessRef[]) {
      const result = new Map<string, SubtreeLiveReason | null>()
      const keyed = refs.flatMap((ref) => {
        const key = wslSessionPidKey(ref.startupScriptPath)
        return key ? [{ sessionId: ref.sessionId, key }] : []
      })
      if (keyed.length === 0) return result
      try {
        const answer = await helper.request<{ verdicts: Record<string, SubtreeLiveReason | null> }>(
          'proc.snapshot',
          { keys: keyed.map((entry) => entry.key) },
          { timeoutMs: SNAPSHOT_TIMEOUT_MS },
        )
        for (const entry of keyed) {
          if (Object.prototype.hasOwnProperty.call(answer.verdicts, entry.key)) {
            result.set(entry.sessionId, answer.verdicts[entry.key] ?? null)
          }
        }
      } catch {
        // Undetermined: every session is held.
      }
      return result
    },
    async killSessionSurvivors(cliSessionId, ref) {
      const key = wslSessionPidKey(ref?.startupScriptPath)
      if (!cliSessionId && !key) return []
      // The pty kill reaches the shell first; what is still there after a
      // moment is what would otherwise run on inside the VM.
      if (survivorDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, survivorDelayMs))
      try {
        const answer = await helper.request<{ killed: number[] }>('proc.killSession', { cliSessionId, key: key ?? '' })
        return Array.isArray(answer.killed) ? answer.killed : []
      } catch {
        return []
      }
    },
    async detectClis(requests) {
      const probes = requests.map(({ cli, runtime }) => cliProbeRequest(cli, { ...runtime, hostId: id }))
      const asked = probes.flatMap((probe) => ('error' in probe ? [] : [probe]))
      let answers: HelperProbeAnswer[] = []
      let failure: string | null = null
      if (asked.length > 0) {
        try {
          const reply = await helper.request<{ results: HelperProbeAnswer[] }>(
            'cli.detect',
            { requests: asked.map((probe) => ({ binary: probe.binary, versionArgs: probe.versionArgs })) },
            { timeoutMs: DETECT_TIMEOUT_MS },
          )
          answers = reply.results
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
      }
      let next = 0
      return probes.map((probe): CliDetectResult => {
        if ('error' in probe) return detectResultFromHelper(probe, { error: probe.error }, id)
        const answer = failure ? { error: failure } : (answers[next] ?? { error: 'The helper gave no answer.' })
        next += 1
        return detectResultFromHelper(probe, answer, id)
      })
    },
    async runCommand(argv, options): Promise<RunOutcome> {
      try {
        return await helper.request<HelperRunOutcome>(
          'run',
          { argv: [...argv], ...(options.cwd ? { cwd: toWslPath(options.cwd) } : {}), timeoutMs: options.timeoutMs },
          { timeoutMs: options.timeoutMs + ANSWER_SLACK_MS },
        )
      } catch (error) {
        return failedRun(error)
      }
    },
    async runGit(cwd, args, options) {
      try {
        const outcome = await helper.request<HelperRunOutcome>(
          'git',
          { cwd: toWslPath(cwd), args: args.map(wslGitArg), timeoutMs: options.timeoutMs, env: options.env },
          { timeoutMs: options.timeoutMs === null ? null : options.timeoutMs + ANSWER_SLACK_MS },
        )
        return { ...outcome, stdout: nativeGitOutput(args, outcome.stdout, distro) }
      } catch (error) {
        return failedRun(error)
      }
    },
    dispose: () => helper.shutdown(),
  }
}
