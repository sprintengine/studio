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
//   - `WslHost`: one per WSL distribution, reached through `wsl.exe` interop
//     (`-d <distro>`, scripts on stdin, `--cd ~`).
//
// The interop transport is phase 2. Phase 3 puts a long-lived helper inside the
// distribution and `WslHost` talks to it over the one `wsl.exe` stdio pipe
// instead; everything that asks a host a question already goes through this
// interface, so that swap is inside `WslHost` and nowhere else. The methods a
// helper answers are marked below.
//
// Not here yet, and added by phase 3 with the helper: the agent-state endpoint
// a hook reports to on this host, the MCP gateway entry a CLI on this host
// starts, and the plugin copy materialised inside the distribution. Today the
// agent-state service and the MCP sync still derive those from the path style.
// =============================================================================

import type { CliDetectResult, CliRuntimeSettings } from '../../shared/electron-api'
import type {
  ExecutionHostId,
  ExecutionHostKind,
  ExecutionHostSettings,
  ExecutionHostSummary,
} from '../../shared/execution-host'
import type { TerminalPathStyle } from '../../shared/ipc/terminal'
import type { RunOutcome } from '../process-run'
import type { SubtreeLiveReason } from '../terminal-subtree-probe'

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
  /** The host's home folder, or null when it could not be read. (Helper: `home()`.) */
  homeDir(): Promise<HostHome | null>

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
   * undetermined and must be held. (Helper: `proc.snapshot`.)
   */
  probeSubtrees(refs: readonly HostProcessRef[]): Promise<Map<string, SubtreeLiveReason | null>>
  /** Ends what a suspended CLI session left running. (Helper: `proc.killSession`.) */
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

  /** Stops whatever the host keeps running for itself. Nothing yet; the helper later. */
  dispose(): Promise<void>
}

/** What a host needs from the settings, read at the moment it is asked. */
export type HostSettingsReader = (id: ExecutionHostId) => ExecutionHostSettings | undefined
