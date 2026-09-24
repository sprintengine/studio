// One WSL distribution, as a machine of its own ("WSL: Ubuntu").
//
// Phase 2 reaches the distribution through `wsl.exe` interop, following the
// rules in `wsl-distro.ts`: every process names its distribution with `-d`,
// every script travels on stdin to `sh -s`, and everything starts in the Linux
// home (`--cd ~`) rather than on the Windows drive it was started from. Phase 3
// replaces the transport with a helper that lives in the distribution; the
// methods keep their meaning, so nothing outside this file changes with it.

import type { CliRuntimeSettings } from '../../shared/electron-api'
import {
  executionHostLabel,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostState,
  type ExecutionHostSummary,
} from '../../shared/execution-host'
import { isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'
import { detectCliBatch } from '../cli-runtime-install'
import type { RunOutcome } from '../process-run'
import { killCliSessionSurvivors, probeWslSubtrees, type SubtreeLiveReason } from '../terminal-subtree-probe'
import { probeWslHome } from '../wsl-home'
import type { ExecutionHost, HostProcessRef, HostSettingsReader } from './execution-host'
import { runWslScript, wslLoginScript, wslSessionPidKey, type WslDistro, type WslScriptRunner } from './wsl-distro'

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// An environment name `export` accepts; anything else is left out of a script
// rather than breaking it.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

function exportLines(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `export ${name}=${quote(value)}`)
}

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
 * The script that runs one git command in the distribution. Git's own
 * environment (the runner's `LC_ALL`, `GIT_TERMINAL_PROMPT`, lock policy) is
 * exported by the script rather than shared through `WSLENV`, so it arrives
 * whatever the person's interop settings are. With a deadline, `timeout` ends
 * git inside the distribution too: killing `wsl.exe` on the Windows side does
 * not reach it.
 */
export function buildWslGitScript(input: {
  cwd: string
  args: readonly string[]
  env: Record<string, string>
  timeoutMs: number | null
}): string {
  const argv = ['git', '-C', toWslPath(input.cwd), ...input.args.map(wslGitArg)].map(quote).join(' ')
  const seconds = input.timeoutMs === null ? null : Math.max(1, Math.ceil(input.timeoutMs / 1000))
  const run =
    seconds === null
      ? `exec ${argv}`
      : `if command -v timeout >/dev/null 2>&1; then exec timeout -k 2 ${seconds} ${argv}; else exec ${argv}; fi`
  return [...exportLines(input.env), run].join('\n')
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
  runScript?: WslScriptRunner
}

export function createWslHost(distro: string, deps: WslHostDeps): ExecutionHost {
  const id: ExecutionHostId = wslHostId(distro)
  const run = deps.runScript ?? runWslScript
  const settings = () => deps.readSettings(id)
  const toNativePath = (hostPath: string) => wslToWindowsPath(hostPath, { distro })
  return {
    id,
    kind: 'wsl',
    pathStyle: 'wsl',
    summary(): ExecutionHostSummary {
      const listed = deps.listed()
      return {
        id,
        kind: 'wsl',
        label: executionHostLabel(id, 'win32'),
        pathStyle: 'wsl',
        ...wslHostState(listed),
        isDefaultDistro: listed?.isDefault ?? false,
        enabled: settings()?.enabled === true,
        wslVersion: listed?.version ?? null,
      }
    },
    toHostPath: (nativePath) => toWslPath(nativePath),
    toNativePath,
    async homeDir() {
      const probed = await probeWslHome(distro)
      return probed ? { host: toWslPath(probed.home), native: probed.home } : null
    },
    launchTarget() {
      const own = settings()
      return { kind: 'wsl', distro, env: own?.env ?? {}, ...(own?.shell ? { shell: own.shell } : {}) }
    },
    cliRuntime(cli, runtime): CliRuntimeSettings {
      return {
        command: (settings()?.cliCommands[cli] ?? '').trim(),
        ...(runtime?.models ? { models: runtime.models } : {}),
        hostId: id,
      }
    },
    async probeSubtrees(refs: readonly HostProcessRef[]) {
      const keyed = refs.flatMap((ref) => {
        const key = wslSessionPidKey(ref.startupScriptPath)
        return key ? [{ sessionId: ref.sessionId, key }] : []
      })
      const verdicts = await probeWslSubtrees(
        distro,
        keyed.map((entry) => entry.key),
        { runWslScript: run },
      )
      const result = new Map<string, SubtreeLiveReason | null>()
      for (const entry of keyed) {
        if (verdicts.has(entry.key)) result.set(entry.sessionId, verdicts.get(entry.key) ?? null)
      }
      return result
    },
    killSessionSurvivors: (cliSessionId, ref) =>
      killCliSessionSurvivors(cliSessionId, {
        platform: 'win32',
        runWslScript: run,
        host: { pathStyle: 'wsl', wslDistro: distro, startupScriptPath: ref?.startupScriptPath },
      }),
    detectClis: (requests) =>
      detectCliBatch(
        requests.map(({ cli, runtime }) => ({ cli, runtime: { ...runtime, hostId: id } })),
        { platform: 'win32', resolveDistro: async () => distro },
      ),
    runCommand(argv, options): Promise<RunOutcome> {
      const body = [
        ...(options.cwd ? [`cd ${quote(toWslPath(options.cwd))} || exit 1`] : []),
        `exec ${argv.map(quote).join(' ')} </dev/null`,
      ].join('\n')
      return run(distro, wslLoginScript(body), { timeoutMs: options.timeoutMs })
    },
    async runGit(cwd, args, options) {
      const outcome = await run(
        distro,
        buildWslGitScript({ cwd, args, env: options.env, timeoutMs: options.timeoutMs }),
        {
          timeoutMs: options.timeoutMs,
        },
      )
      return { ...outcome, stdout: nativeGitOutput(args, outcome.stdout, distro) }
    },
    dispose: async () => undefined,
  }
}
