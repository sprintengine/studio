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
      /**
       * The helper's private directory for launch files, as Linux names it. The
       * startup script and the host-context file are written there (through
       * the helper) and run from there, never through a `/mnt/<drive>` mount.
       * Absent while the helper is not up; a WSL launch cannot start then.
       */
      sessionDir?: string
      /** The helper's private directory the startup script records its shell's pid in. */
      pidDir?: string
      /** This launch's MCP channel token, exported by the startup script (`MCP_CHANNEL_TOKEN_ENV`). */
      channelToken?: string
    }

/** A file a launch needs on its host, written there before the terminal starts. */
export type HostLaunchFile = {
  /** The absolute path as the host names it; inside the launch target's `sessionDir`. */
  path: string
  content: string
}

/** A directory watch on a host, shaped like the part of `fs.FSWatcher` its users need. */
export type HostDirWatcher = {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
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
  /**
   * The app's MCP gateway as a stdio server a CLI there starts. `envVarNames`
   * are variables the CLI must pass on to it from its own environment.
   */
  studioMcpEntry: { command: string; args: string[]; env: Record<string, string>; envVarNames?: string[] }
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
   * Writes a launch's files on the host before its terminal starts. Only a host
   * whose launch target names a `sessionDir` (WSL, through its helper) has
   * this; the local hosts' builders write their own files. Rejects with the
   * reason when the files could not be written.
   */
  writeLaunchFiles?(files: readonly HostLaunchFile[]): Promise<void>
  /**
   * Removes launch files by the paths `writeLaunchFiles` wrote. Best-effort,
   * and never starts anything: a stopped helper's files go when the app next
   * starts it.
   */
  discardLaunchFiles?(paths: ReadonlyArray<string | undefined>): void
  /**
   * A token for one launch's MCP bridge (WSL): only a channel that opens with
   * a live launch's token reaches the automation server. Revoked when that
   * launch's session ends.
   */
  issueChannelToken?(): string
  revokeChannelToken?(token: string): void
  /**
   * Watches a directory on the host, for hosts where a watch placed from this
   * machine hears nothing (a `\\wsl.localhost` path). `listener` gets the
   * changed entry's name, or null when the host could not say.
   */
  watchDir?(nativePath: string, recursive: boolean, listener: (filename: string | null) => void): HostDirWatcher
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
   * whole subtree. (Helper: `proc.killSession`.) `quitting` is the app's own
   * shutdown: no grace (the ptys were already waited on), and nothing is
   * started to do it.
   */
  killSessionSurvivors(
    cliSessionId: string,
    ref?: { startupScriptPath?: string; quitting?: boolean },
  ): Promise<number[]>

  // ── Tooling ────────────────────────────────────────────────────────────────

  /**
   * Finds CLIs on this host's PATH, in one process where the host allows.
   * (Helper: `cli.detect`.) `force` runs every found binary's `--version` again
   * rather than reusing what the host remembers of it.
   */
  detectClis(requests: readonly HostCliDetectRequest[], options?: { force?: boolean }): Promise<CliDetectResult[]>
  /** Runs an argv on this host with a deadline. Never a shell string. (Helper: `run`.) */
  runCommand(argv: readonly string[], options: { timeoutMs: number; cwd?: string }): Promise<RunOutcome>
  /**
   * Runs git in a repository on this host: `cwd` is native, and so are the
   * paths in what comes back. `timeoutMs` null is no deadline (a write runs
   * the repository's hooks). `env` is exported for git itself, and `stdin`,
   * when given, is written to git's stdin and closed (`apply -`,
   * `check-ignore --stdin`). The app's git runner (`git-run.ts`) owns the
   * kind, deadline and environment rules and calls this only for a repository
   * whose host is not this machine; local git stays on its own `execFile`
   * path. (Helper: `git`.)
   */
  runGit(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs: number | null; env: Record<string, string>; stdin?: string },
  ): Promise<RunOutcome>

  /** Stops whatever the host keeps running for itself: the WSL helper. */
  dispose(): Promise<void>
}

/** What a host needs from the settings, read at the moment it is asked. */
export type HostSettingsReader = (id: ExecutionHostId) => ExecutionHostSettings | undefined
