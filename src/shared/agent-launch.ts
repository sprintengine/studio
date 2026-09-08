/**
 * The agent-launch contract main owns (MC-2159).
 *
 * Launching an agent used to be split in two: a React hook decided the CLI,
 * permission preset, connector environment, name, and specialist prompt, wrote
 * an `AgentState`, and left the actual spawn to whichever `TerminalView` mounted
 * afterwards. Every one of those decisions is data, none of it is presentation —
 * but because it lived in the renderer, `agent.launch`, `backlog.work`, and
 * agent-backed `automation.run` all failed outright when no window was open.
 *
 * The decision layer now lives in `src/main/agent-launch-service.ts`. This
 * module is the vocabulary both sides speak:
 *
 * - {@link AgentLaunchRequest} — what a caller asks for. Identical in shape to
 *   the old `agent.launch` renderer request, so the gateway, the automations
 *   executor, and the plan orchestrators migrate without changing what they send.
 * - {@link AgentLaunchRecord} — what main DECIDED, carried back on the terminal
 *   session snapshot. The renderer projects it into an `AgentState` so the tab
 *   is a view of main's session list rather than the thing that created it.
 *   Its lifetime is the session's: when the pty is gone, so is the record, and
 *   a window opened an hour later projects exactly the sessions still running.
 */
import type { AgentCli, McpSettings, SprintEngineCliPermissionPreset } from './electron-api'

export type AgentLaunchRequest = {
  workspaceId: string
  /** Agent CLI plugin id. Absent takes the user's last-selected CLI. */
  cli?: string
  /** Display name. Absent picks an unused name from the shared pool. */
  name?: string
  /** Startup prompt delivered to the CLI at launch. */
  prompt?: string
  /** Model id for CLIs declaring modelSelection; forwarded verbatim. */
  cliModel?: string
  /** Absent takes the app-level agent-spawn default (MC-1900). */
  permissionPreset?: SprintEngineCliPermissionPreset
  /** When set, the agent launches as a specialist rather than a general agent. */
  specialistId?: string
  /** Git worktree to run in, instead of the workspace checkout. */
  worktreePath?: string
  /** Catalog connector id (e.g. 'railway'); resolves to an isolated single-server MCP. */
  connectorId?: string
  /** Built-in skill installed into the working directory before the CLI starts. */
  spawnSkillId?: string
}

export type AgentDisposeRequest = {
  workspaceId: string
  agentId: string
}

/**
 * The launch-time decisions main made, in `AgentState` vocabulary.
 *
 * Everything here is something the renderer could not re-derive from the raw
 * session snapshot: the snapshot knows the cli and cwd, but not which permission
 * preset was rendered into the launch argv, which specialist the prompt was
 * wrapped for, or which connector config was written into the worktree. A
 * projection missing those fields would look right and behave wrong on the first
 * relaunch.
 */
export type AgentLaunchRecord = {
  agentId: string
  name: string
  cli: AgentCli
  cliModel?: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  kind: 'general' | 'specialist'
  specialistId?: string
  connectorMcpSettings?: McpSettings
  connectorSkillId?: string
  spawnSkillId?: string
  /**
   * The worktree the agent runs in, when the launch created or was handed one.
   * Projected onto `AgentState.execution` so a reopened tab resolves the same
   * cwd instead of falling back to the workspace root.
   */
  worktreePath?: string
}

export type AgentLaunchResult =
  | { ok: true; workspaceId: string; agentId: string; sessionId: string }
  | { ok: false; code: string; message: string }

export type AgentDisposeResult =
  | { ok: true; workspaceId: string; agentId: string }
  | { ok: false; code: string; message: string }
