/**
 * The renderer's `AgentState` record and its data-only field types, shared
 * with the main process.
 *
 * Relocated verbatim from `src/renderer/src/types/workspace.ts`
 * (sprint-runtime-ownership Phase 2: the shared Sprint Engine planner reads
 * `workspace.agents`, so the agent record shape must live in `src/shared`).
 * `workspace.ts` re-exports every name here, so existing renderer import
 * sites keep working unchanged. Pure data shapes only — no DOM, React, or
 * flexlayout imports may be added here.
 */
import type { AgentCli, AgentId } from './run-types'
import type { SprintEngineCliPermissionPreset } from './automation-types'

type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'

export type AgentKind = 'general' | 'specialist' | 'sprintengine'
export type AgentExecutionMode = 'current_workspace' | 'worktree'

// A specialist id is a registry role id. Specialists ship as an installable
// pack (not bundled), so there is no fixed union of ids: every specialist —
// whether from the first-party pack or a workspace/user/plugin registry layer —
// is keyed by its registry role id, which round-trips through prefs and spawns
// and whose brief is the matching workspace skill. Kept as a named alias so
// the many downstream import sites need no churn.
export type SpecialistActionId = string

export type McpClientTarget = AgentCli
type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
// These MCP shapes are the twin of the ones in src/shared/electron-api.ts (the
// renderer re-exports them from here, the IPC contract declares them there);
// they are structurally identical on purpose and must be changed together.
// 'source' — a server a source installed, owned by Sync — arrived with
// backlog/2026-09-06-mcp-installs-carry-source-provenance.md.
export type McpServerSource = 'bundled' | 'custom' | 'source'
type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

export type McpServerSourceRef = {
  sourceId: string
  itemId: string
  commitSha: string
  /** Set by a sync that no longer found `itemId` in the source. */
  missing?: boolean
  /**
   * Where the declaring plugin's own files landed, for a server whose command
   * was `${CLAUDE_PLUGIN_ROOT}`-relative. Absent for every other server; the
   * contract's copy in electron-api.ts carries the full reasoning.
   *
   * Added here on 2026-09-06. The field landed on the contract alone
   * (b3b1c81a0) and this twin kept the shorter shape, which is exactly the
   * drift `server-from-scanned.test.ts` guards — "a provenance field added to
   * one and not the other is a config that loses its source somewhere between
   * the two". The guard was right and had simply not been run: verify:app was
   * halting 226 steps before it.
   */
  pluginRoot?: string
}

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  /** Present exactly when `source` is 'source'; see McpServerSourceRef. */
  sourceRef?: McpServerSourceRef
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

export type AgentExecution = {
  mode: AgentExecutionMode
  worktreeId: string | null
  cwd: string | null
}

// Standard workspace agents run through one of two runtimes. `terminal` is the
// default CLI/PTY path (and the only runtime for Sprint Engine agents).
// `conversation` is the plugin-driven conversation runtime backed by a
// provider/model selection. Older persisted agents have no `runtimeKind` and
// must be treated as `terminal`.
export type AgentRuntimeKind = 'terminal' | 'conversation'

// Conversation runtime selection for a standard workspace agent. `providerId`
// and `modelId` reference an installed conversation provider plugin (see
// `conversation:providers:list`). Absent for terminal agents.
export type AgentConversationRuntime = {
  providerId: string
  modelId: string
}

export type AgentState = {
  id: AgentId
  name: string
  status: AgentStatus
  execution: AgentExecution
  messages: AgentMessage[]
  streamBuffer: string
  // Runtime routing. Undefined is treated as `terminal` for back-compat; the
  // conversation runtime additionally requires a valid `conversation` pair.
  runtimeKind?: AgentRuntimeKind
  conversation?: AgentConversationRuntime
  cliSessionId?: string
  // The agent's session id within its CLI/harness, captured from lifecycle hooks
  // (the snapshot's `cliSessionId`). Distinct from `cliSessionId` above, which is
  // our terminal-tracking key. Used as the resume token so non-Claude CLIs (e.g.
  // Codex, which mints its own id) resume the right conversation. For Claude it
  // coincides with the terminal key. Persisted so resume survives a restart.
  harnessSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
  // Whether this agent's CLI resumes with the session id WE mint (Claude-family)
  // vs. minting its own (Codex). Stamped from the plugin manifest capability
  // (`sessionIdFromCaller`) at session assign, the sibling of cliResumeAvailable;
  // consumers use it to decide the resume token. See agent-cli-resume.ts.
  cliUsesStableSessionId?: boolean
  // Explicit "resume this conversation on next launch" intent. Sprint agents are
  // otherwise always spawned fresh (auto-run re-dispatches roles); this flag is
  // set only by an explicit board re-open of a completed run's recorded session
  // (see sprintEngineRosterSessions) so TerminalView resumes rather than starting
  // a new conversation.
  cliResumeRequested?: boolean
  cliLastExitCode?: number | null
  cliLastExitedAt?: number | null
  cli?: AgentCli
  // Model id passed at CLI launch when the plugin declares modelSelection.
  // Undefined means the CLI's own default; persisted so relaunch/resume and
  // Sprint Engine auto-run keep the model the agent was created with.
  cliModel?: string
  // Reasoning-effort level passed at CLI launch when the plugin declares
  // reasoningSelection. Undefined means the CLI's own default effort (no flag);
  // persisted alongside cliModel so a relaunch keeps the effort the agent was
  // created with. Scoped by `cli` at the surface that resolved it
  // (resolveCliReasoning), so it is always a level this agent's CLI accepts.
  cliReasoning?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  // Explicit per-agent runtime override (MC-1450). Wins over the run's
  // per-role `roleRuntimes` config on every reconcile and spawn — set by the
  // board's per-agent CLI/model picker and by creation-time per-agent CLI
  // overrides. `model: null` means "explicitly the CLI default" (suppresses a
  // role-configured model); an absent field falls through to the role config.
  // `reasoning` layers identically for the effort level (MC-1885).
  // Without this marker the reconcile could not tell a user's mid-run pick
  // from a stale snapshot and would revert the pick on the next projection.
  cliRuntimeOverride?: { cli?: AgentCli; model?: string | null; reasoning?: string | null }
  // The runtime the live terminal was actually launched with, stamped at spawn
  // success (TerminalView). The record's `cli`/`cliModel` are re-stamped from
  // the run's `roleRuntimes` on every reconcile, so after a mid-run role edit
  // they reflect the NEW config while the running session still uses the old
  // one; this stamp preserves what the session is really on, powering the
  // roster's "on <old model>" divergence label and restart offer. Never
  // cleared on exit — consumers must gate on terminal liveness.
  cliLaunchedRuntime?: { cli?: AgentCli; model?: string | null }
  // Orthogonal Debug Mode toggle (the agent picker). Set per-spawn from the
  // transient spawn-UI state; the launch boundary prepends the debug directive
  // to the initial prompt when true. Not persisted-by-default UI: defaults off
  // each spawn, but recorded on the agent so the launch path can read it.
  debugMode?: boolean
  cliStartupPrompt?: string
  // Last user edit to renderer-owned per-agent config (cliRuntimeOverride,
  // name, cliStartupPrompt), stamped by the store's updateAgent. The main
  // scheduler's config merge is last-write-wins on this stamp, so a window
  // whose store lags the newest edit can never clobber it when it
  // re-registers its run.
  configEditedAt?: number
  // Connector chat: a worktree-isolated solo chat scoped to one MCP connector.
  // `connectorMcpSettings` is the connector-only MCP config the spawn forwards
  // *instead of* the global appSettings.mcp, so the connector server is written
  // into this worktree's .mcp.json and nowhere else. Read by the TerminalView
  // launch path.
  connectorMcpSettings?: McpSettings
  // Skill-at-spawn (the composer's "+ Skill" attachment): ensure-installed at
  // the launch boundary, with none of the connector MCP coupling. Works for any
  // agent spawn, not just connectors.
  spawnSkillId?: string
  // One-shot input pasted (bracketed, unsubmitted) into the PTY right after a
  // successful launch — the skill invocation sits at the prompt with the caret
  // ready for arguments. Cleared by TerminalView once pasted; never auto-sent.
  cliPendingInput?: string
  // Conversation-transport counterpart: seeds AgentChatView's draft on first
  // mount (transcript empty). Prefill only — the user always submits.
  chatComposerPrefill?: string
  kind?: AgentKind
  specialistId?: SpecialistActionId
  // The Backlog item this agent was last handed (drag-drop or send-to-agent).
  // Powers the top-right glyph on the agent terminal that navigates back to the
  // item. Latest-wins: one ref per agent, mirroring the most-recent-wins
  // fixed link id on the Backlog item side. Undefined when no item was handed.
  backlogItemRef?: AgentBacklogItemRef
}

type AgentBacklogItemRef = {
  // Project-root-relative `backlog/...` path; the select key for reverse nav.
  relativePath: string
  // Item title, kept so the glyph's tooltip/accessible name needs no file read.
  title: string
  linkedAt: number
}
// ---------------------------------------------------------------------------
// Record construction (MC-2160)
// ---------------------------------------------------------------------------
//
// The blank agent record every creation path starts from. It lived in the
// renderer's agents slice until main began composing sprint workspaces itself;
// a second copy in main would drift the moment a field is added, so both
// processes mint records here. `agentsSlice.ts` re-exports these so existing
// renderer import sites are unchanged.

export function defaultAgentExecution(): AgentExecution {
  return { mode: 'current_workspace', worktreeId: null, cwd: null }
}

export function defaultAgent(id: AgentId, name = id, kind: AgentKind = 'general'): AgentState {
  return {
    id,
    name,
    status: 'idle',
    execution: defaultAgentExecution(),
    messages: [],
    streamBuffer: '',
    runtimeKind: 'terminal',
    conversation: undefined,
    cliSessionId: undefined,
    harnessSessionId: undefined,
    cliStartRequested: false,
    cliRestartNonce: 0,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
    cliResumeAvailable: false,
    cli: undefined,
    cliModel: undefined,
    cliPermissionPreset: 'manual',
    cliStartupPrompt: undefined,
    kind,
    specialistId: undefined,
    backlogItemRef: undefined,
  }
}
