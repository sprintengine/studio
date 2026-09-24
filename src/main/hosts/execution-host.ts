// =============================================================================
// The execution host, main-process side
//
// A host is the machine a workspace's processes run on (see
// `shared/execution-host.ts` for the model). Main owns every session; the host
// answers "how does this run over there": which path style its shell speaks,
// how a native path is named on it, how its processes are read and ended, how
// its CLIs are found and run, and which git runs its repositories.
//
// Three implementations exist:
//
//   - `PosixLocalHost`: macOS and Linux, the only host there. It is a move of
//     what those platforms always did; nothing about a launch changes.
//   - `WindowsHost`: this PC, natively (PowerShell, CIM process reads).
//   - `WslHost`: one per WSL distribution. Everything it answers comes from a
//     long-lived helper inside the distribution (`resources/wsl-helper/`),
//     reached over the stdio of one `wsl.exe` (`wsl-helper-client.ts`). The
//     methods the helper answers are marked below.
//
// A host also says how an agent there reports back (`agentIntegration`): the
// socket its hooks write to, the Node that runs them, the MCP gateway entry,
// and the app's plugin copy. The local hosts answer null, which means the
// app's own socket and copy on this machine, exactly as before hosts existed.
// =============================================================================

import type { AgentStateCommandRuntime } from '../agent-state'
import type { CliDetectResult, CliRuntimeSettings } from '../../shared/electron-api'
import type {
  ExecutionHostId,
  ExecutionHostKind,
  ExecutionHostSettings,
  ExecutionHostSummary,
} from '../../shared/execution-host'
import type { TerminalPathStyle } from '../../shared/ipc/terminal'
import type { RunOutcome } from '../process-run'
import type { SubtreeLiveReason, SubtreeProbeDeps } from '../terminal-subtree-probe'

/**
 * What the launch builders need to know about the machine a launch runs on.
 * The builders in `terminal-launch.ts` write the startup script; this says
 * which of their three shapes to write and what goes into it.
 */
export type HostLaunchTarget =
  | { kind: 'posix' }
  | { kind: 'windows' }
  | {
      kind: 'wsl'
      /** `-d <distro>`; null runs the default distribution (only when none is known). */
      distro: string | null
      /** The machine's own extra environment, exported by the startup script. */
      env: Record<string, string>
      /** The shell a terminal ends in. Absent is `bash -li`. */
      shell?: string
      /** How an agent here reports back; null before the helper is up. */
      integration?: HostAgentIntegration | null
      /**
       * The launch's agent identity (`SPRINTENGINE_AGENT_ID` and the rest),
       * exported by the startup script. Windows variables reach Linux only
       * through `WSLENV`, which the person's own configuration may override, so
       * the identity travels in the script, like every other launch variable.
       */
      identity?: Record<string, string>
    }

/**
 * How an agent on a host that is not this machine reports back. Every path is
 * as that host's processes name it.
 */
export type HostAgentIntegration = {
  /** The Unix socket hooks, the status line and OpenCode's plugin write frames to. */
  agentStateSocketPath: string
  /**
   * What runs a hook script there: the host's own Node, and how a script main
   * copied (a native path) is named on the host.
   */
  commandRuntime: AgentStateCommandRuntime
  /** `--plugin-dir` arguments for the app's plugin copy; empty when it is not there. */
  pluginDirs: string[]
  /** The status-line forwarder inside that copy, or null. */
  statusLineScriptPath: string | null
  /** The app's MCP gateway as a stdio server a CLI there starts. */
  studioMcpEntry: { command: string; args: string[]; env: Record<string, string> }
  /** The host's home, for a user-scoped hook registration and the status line's settings. */
  home: HostHome
}

/** A session to probe, in the host's own terms. */
export type HostProcessRef = {
  sessionId: string
  /** The pty's pid. For WSL that is the Windows `wsl.exe`, which means nothing inside. */
  rootPid: number
  /** The WSL startup script, whose name keys the pid file its shell writes. */
  startupScriptPath?: string
}

export type HostCliDetectRequest = { cli: string; runtime?: Partial<CliRuntimeSettings> }

export type HostHome = {
  /** The home as the host's own processes name it (`/home/dev`). */
  host: string
  /** The same folder as main's file system opens it (`\\wsl.localhost\Ubuntu\home\dev`). */
  native: string
  /**
   * The config-home variables the person's login shell sets (`CLAUDE_CONFIG_DIR`,
   * `CODEX_HOME`, `XDG_CONFIG_HOME`), as native paths. Only a WSL host reads them.
   */
  env?: Record<string, string>
}

export interface ExecutionHost {
  readonly id: ExecutionHostId
  readonly kind: ExecutionHostKind
  readonly pathStyle: TerminalPathStyle

  /** The host as the picker and Settings show it, from what is known now. */
  summary(): ExecutionHostSummary

  // ── Paths ──────────────────────────────────────────────────────────────────
  // "Native" is a path main's own file system opens.

  /** A native path as this host's processes name it. Idempotent. */
  toHostPath(nativePath: string): string
  /** A path as this host names it, back as a native path. Idempotent. */
  toNativePath(hostPath: string): string
  /** The host's home folder, or null when it could not be read. (Helper: `home`.) */
  homeDir(): Promise<HostHome | null>

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Gets the host ready for a launch: for WSL, starts the helper (installing
   * it on first use) and materialises the plugin copy. Rejects with a
   * `WslSetupError` whose message says why the machine cannot be used. The
   * local hosts are always ready.
   */
  prepare(): Promise<void>
  /** Holds the host while a session lives on it. Keyed, so a second call is harmless. */
  retainSession(leaseId: string): void
  /** Lets go of a session's hold; the helper stops a while after the last one. */
  releaseSession(leaseId: string): void
  /** How an agent here reports back; null on the local hosts, and on WSL before `prepare`. */
  agentIntegration(): HostAgentIntegration | null

  // ── Launch ─────────────────────────────────────────────────────────────────

  /** Which startup script shape a launch here writes, and what goes in it. */
  launchTarget(): HostLaunchTarget
  /**
   * A CLI's runtime on this host: this host's own command override and its id.
   * The local host keeps the command the CLI runtime already carries.
   */
  cliRuntime(cli: string, runtime: Partial<CliRuntimeSettings> | undefined): CliRuntimeSettings

  // ── Processes ───────────────────────────────────────────────────────────────

  /**
   * Live-work verdicts by session id: a session absent from the result is
   * undetermined and must be held. (Helper: `proc.snapshot`.) `deps` stands in
   * for the OS reads of the local hosts in tests.
   */
  probeSubtrees(
    refs: readonly HostProcessRef[],
    deps?: SubtreeProbeDeps,
  ): Promise<Map<string, SubtreeLiveReason | null>>
  /**
   * Ends what a suspended or closed session left running: every process
   * carrying `--session-id <cliSessionId>`, and on WSL the session shell's
   * whole subtree. (Helper: `proc.killSession`.)
   */
  killSessionSurvivors(cliSessionId: string, ref?: { startupScriptPath?: string }): Promise<number[]>

  // ── Tooling ────────────────────────────────────────────────────────────────

  /** Finds CLIs on this host's PATH, in one process where the host allows. (Helper: `cli.detect`.) */
  detectClis(requests: readonly HostCliDetectRequest[]): Promise<CliDetectResult[]>
  /** Runs an argv on this host with a deadline. Never a shell string. (Helper: `run`.) */
  runCommand(argv: readonly string[], options: { timeoutMs: number; cwd?: string }): Promise<RunOutcome>
  /**
   * Runs git in a repository on this host: `cwd` is native, and so are the
   * paths in what comes back. `timeoutMs` null is no deadline (a write runs
   * the repository's hooks). `env` is exported for git itself. The app's git
   * runner (`git-run.ts`) owns the kind, deadline and environment rules and
   * calls this only for a repository whose host is not this machine; local
   * git stays on its own `execFile` path. (Helper: `git`.)
   */
  runGit(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs: number | null; env: Record<string, string> },
  ): Promise<RunOutcome>

  /** Stops whatever the host keeps running for itself: the WSL helper. */
  dispose(): Promise<void>
}

/** What a host needs from the settings, read at the moment it is asked. */
export type HostSettingsReader = (id: ExecutionHostId) => ExecutionHostSettings | undefined
