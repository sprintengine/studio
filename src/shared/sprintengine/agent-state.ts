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

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type AgentStatus = 'idle' | 'running' | 'streaming' | 'error' | 'complete'

export type MultiloopRole =
  | 'coordinator'
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'performance'
  | 'cross_platform'

export type AgentKind = 'general' | 'specialist' | 'watchtower' | 'sprintengine' | 'multiloop'
export type AgentExecutionMode = 'current_workspace' | 'worktree'

// Ids of the built-in specialist actions shipped in SPECIALIST_ACTIONS.
export type BundledSpecialistActionId =
  | 'architect'
  | 'product-strategist'
  | 'developer'
  | 'devops-infra'
  | 'performance'
  | 'production-readiness-review'
  | 'cross-platform'
  | 'blog-writer'
  | 'qa-test'
  | 'security-review'
  | 'frontend-design-review'
  | 'ui-ux-review'

// A specialist id is either a bundled action id or a registry-discovered role id
// (from a workspace / user / plugin specialist pack). The `(string & {})` arm
// keeps editor autocomplete for the bundled ids while accepting any registry
// role id, so dropped-in specialist packs round-trip through prefs and spawns.
export type SpecialistActionId = BundledSpecialistActionId | (string & {})

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
export type McpServerSource = 'bundled' | 'custom'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

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
// default CLI/PTY path (and the only runtime for Sprint Engine and Multiloop
// agents). `conversation` is the plugin-driven conversation runtime backed by a
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
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  // Explicit per-agent runtime override (MC-1450). Wins over the run's
  // per-role `roleRuntimes` config on every reconcile and spawn — set by the
  // board's per-agent CLI/model picker and by creation-time per-agent CLI
  // overrides. `model: null` means "explicitly the CLI default" (suppresses a
  // role-configured model); an absent field falls through to the role config.
  // Without this marker the reconcile could not tell a user's mid-run pick
  // from a stale snapshot and would revert the pick on the next projection.
  cliRuntimeOverride?: { cli?: AgentCli; model?: string | null }
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
  // Connector chat (Railway, etc.): a worktree-isolated solo chat scoped to one
  // MCP connector plus its driving skill. `connectorMcpSettings` is the
  // connector-only MCP config the spawn forwards *instead of* the global
  // appSettings.mcp, so the connector server is written into this worktree's
  // .mcp.json and nowhere else; `connectorSkillId` is the builtin skill the spawn
  // installs into the worktree so the seeded invocation resolves. Both are seeded
  // at creation by launchConnectorChat and read by the TerminalView launch path.
  connectorMcpSettings?: McpSettings
  connectorSkillId?: string
  // Skill-at-spawn (the composer's "+ Skill" attachment): ensure-installed at
  // the launch boundary like connectorSkillId, but with none of the connector
  // MCP coupling. Works for any agent spawn, not just connectors.
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
  multiloopRole?: MultiloopRole
  // The Backlog item this agent was last handed (drag-drop or send-to-agent).
  // Powers the top-right glyph on the agent terminal that navigates back to the
  // item. Latest-wins: one ref per agent, mirroring the most-recent-wins
  // fixed link id on the Backlog item side. Undefined when no item was handed.
  backlogItemRef?: AgentBacklogItemRef
}

export type AgentBacklogItemRef = {
  // Project-root-relative `backlog/...` path; the select key for reverse nav.
  relativePath: string
  // Item title, kept so the glyph's tooltip/accessible name needs no file read.
  title: string
  linkedAt: number
}