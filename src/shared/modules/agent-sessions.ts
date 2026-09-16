// Agent sessions for a capability module's `entry.main` (D5 of the Reviews
// extraction).
//
// A module that runs a background agent has, until now, had two doors and
// neither fits a long-lived working agent. The companion service (`agents:
// companion`) drives a conversation-runtime session: no pty, no tab, no CLI of
// the user's choosing. `ipc:agents` discloses the raw terminal API, which is a
// renderer surface — a module's main entry cannot reach it, and a module that
// could would be composing a launch by hand (CLI defaults, permission preset,
// MCP settings, knowledge roots, the agent-session identity the runtime needs
// to report an exit at all).
//
// This is the third door and the one the in-tree review guide has always
// actually used: an ordinary agent TERMINAL, spawned in the workspace the
// module's surface was opened from, under whichever CLI the user picked, with
// a skill attached at spawn — plus the small set of controls a module needs to
// keep it: send another prompt, kill it, hold it out of the idle reaper's
// reach, hear about its exit, and list the ones it owns.
//
// Scoping is by AGENT ID PREFIX. A module spawns under a prefix it registered
// (`registerAgentIdNamespace` on the renderer side), and `list()` answers only
// for sessions under its own prefixes — so one module can never enumerate,
// prompt, or kill another's agents, nor the user's own.
//
// Runtime-checked: every method refuses unless the module's manifest declares
// `agents:session`. That makes it the third scope the platform genuinely gates
// (with `ipc:invoke` and `agents:companion`), for the same reason — there is no
// shared permission broker for it to inherit.

/**
 * A terminal agent session as a module sees it: the coordinates it needs to
 * address the session again, and the liveness facts it needs to decide whether
 * to. Deliberately narrower than the app's `TerminalSessionSnapshot` — a module
 * gets identity and liveness, never scrollback, cwd, or file-change telemetry.
 */
export type ModuleAgentSessionRecord = {
  sessionId: string
  agentId: string | null
  name: string | null
  cli: string | null
  workspaceId: string | null
  executionId: string | null
  /** The pty is running and not frozen by the idle reaper. */
  isLive: boolean
  suspended: boolean
  reapExempt: boolean
  startedAt: number
}

export type ModuleAgentSpawnRequest = {
  /**
   * The workspace the agent belongs to. Required: a module surface is always
   * opened FROM somewhere, and an agent parked in a workspace nobody named is
   * one the user cannot find again.
   */
  workspaceId: string
  /** Absolute working directory for the agent's terminal. */
  cwd: string
  /** Agent CLI plugin id. Absent takes the user's last-selected CLI. */
  cli?: string
  /** Model id for CLIs declaring modelSelection; forwarded verbatim. */
  cliModel?: string
  /** Delivered as the opening turn on a fresh spawn, or pasted into a reused one. */
  prompt: string
  /**
   * A skill the host installs into the working directory before the CLI starts.
   * An id the host cannot resolve fails the spawn with `unknown_skill` rather
   * than starting an agent without the instructions it was meant to run on.
   * The CLI-native invocation comes back as `skillInvocation` for the prompt to
   * lead with.
   */
  skill?: { id: string }
  /** Session-manager label for the terminal. Absent picks a name from the shared pool. */
  label?: string
  /**
   * The agent's identity: `${agentIdPrefix}${agentIdKey}`. The prefix must be a
   * namespace this module registered; the key is whatever the module keys its
   * agents by (a review id, a document id). Stable across spawns, which is what
   * `reuseLive` and `list()` match on. Absent mints an app-owned id.
   */
  agentIdPrefix?: string
  agentIdKey?: string
  /**
   * The launch permission preset. Absent takes the user's configured default —
   * never an escalation the module chose for them.
   */
  permissionPreset?: 'none' | 'manual' | 'auto' | 'bypass'
  /**
   * Deliver the prompt to a live session under the same agent id instead of
   * spawning a second one (`reused: true`). Default true; a dead or suspended
   * session under that id is disposed and replaced either way.
   */
  reuseLive?: boolean
  /** Free-form role ('review-guide'). Accepted; the host does not record it today. */
  role?: string
}

export type ModuleAgentSpawnResult =
  | {
      ok: true
      sessionId: string
      agentId: string
      executionId: string
      workspaceId: string
      cli: string
      reused: boolean
      /**
       * The CLI-native explicit invocation for the requested skill (`/review-guide`
       * on Claude, `Use $review-guide.` on Codex). Absent when no skill was asked
       * for, or when this CLI's plugin declares no native skill form — point the
       * agent at the installed `.agents/skills/<id>/SKILL.md` instead.
       */
      skillInvocation?: string
    }
  | {
      ok: false
      code:
        | 'unknown_workspace'
        | 'missing_cwd'
        | 'no_cli_selected'
        | 'cli_not_agent_selectable'
        | 'unknown_skill'
        | 'spawn_failed'
        | 'send_failed'
        | 'permission_missing'
      message: string
    }

/** A module agent's terminal ended. Fans out from the runtime's own exit report. */
export type ModuleAgentExitEvent = {
  agentId: string | null
  executionId: string
  workspaceId: string | null
  exitCode: number
}

/**
 * Terminal agent sessions for a module's `entry.main`, obtained via
 * `getAgentSessionService(host)`.
 *
 * Declare the `agents:session` permission — every method here checks it — and
 * `dependsOn: ['agent-runtime']` so the service exists before your entry runs.
 */
export type ModuleAgentSessionService = {
  spawn(request: ModuleAgentSpawnRequest): Promise<ModuleAgentSpawnResult>
  /** One prompt into a live session, submitted as a turn, serialized per session. */
  send(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  kill(sessionId: string): void
  /**
   * Hold a session out of the idle reaper's reach while it is mid-task. The
   * host clears the exemption when that session exits, so a module that never
   * balances its own call cannot leave an unsuspendable pty behind.
   */
  setReapExempt(sessionId: string, exempt: boolean): void
  onExit(listener: (event: ModuleAgentExitEvent) => void): () => void
  /** Only sessions whose agent id starts with a prefix this module owns. */
  list(): ModuleAgentSessionRecord[]
}

/**
 * The moduleId-first registry the host provides under
 * `AgentSessionsModuleServiceToken`; the SDK helper closes over `host.moduleId`.
 */
export type AgentSessionsRegistry = {
  spawn(moduleId: string, request: ModuleAgentSpawnRequest): Promise<ModuleAgentSpawnResult>
  send(moduleId: string, sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
  kill(moduleId: string, sessionId: string): void
  setReapExempt(moduleId: string, sessionId: string, exempt: boolean): void
  onExit(moduleId: string, listener: (event: ModuleAgentExitEvent) => void): () => void
  list(moduleId: string): ModuleAgentSessionRecord[]
}
