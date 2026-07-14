import type { AgentPhase, AgentSessionSystem } from './electron-api'

// Generic agent-session runtime contracts. These describe how the core
// terminal runtime spawns, inventories, and reports exits for *any* system's
// agent sessions (switchboard, watchtower, sprintengine, …). System-specific
// modules layer their own behavior on top via the runtime's generic seams.

export type AgentInjectionMode =
  | 'positional-arg'
  | 'stdin-pipe'
  | 'send-after-ready'

export type AgentReadinessSignal = {
  type: 'output-match'
  pattern: string
  timeoutMs: number
}

export type AgentInjectionSpec = {
  mode: AgentInjectionMode
  readiness?: AgentReadinessSignal
}

export type AgentCompletionMode = 'process-exit' | 'output-sentinel'

export type AgentCompletionSpec = {
  mode: AgentCompletionMode
  sentinel?: string
}

export type AgentSpawnDescriptor = {
  executionId: string
  system: AgentSessionSystem
  workId: string
  role: string
  displayName: string
  command: string[]
  cwd: string
  env?: Record<string, string>
  prompt?: string
  cli?: 'codex' | 'claude-code'
  // When present, the runtime injects the prompt via the named mode instead of
  // always using stdin-pipe with EOF.
  injection?: AgentInjectionSpec
  // When `completion.mode === 'output-sentinel'`, the runtime watches the pty
  // output for the sentinel literal and disposes the session as soon as it sees
  // one, instead of waiting for the process to exit.
  completion?: AgentCompletionSpec
}

// A live agent execution surfaced by the runtime inventory, tagged with the
// owning system so a module can filter the inventory down to its own sessions.
export type LiveAgentExecution = {
  system: AgentSessionSystem
  executionId: string
}

// Fired by the runtime when any agent session's process exits. Listeners filter
// on `system` to react only to their own executions. `agentId` rides alongside
// `executionId` so a consumer can correlate on (workspaceId, agentId) — the pair
// an agent-state frame carries — instead of depending on an execution id that is
// only resolvable while the terminal is live.
export type AgentSessionExitEvent = {
  system: AgentSessionSystem
  workspaceRoot: string
  workspaceId?: string
  agentId?: string
  executionId: string
  exitCode: number
}

export type AgentSessionExitListener = (event: AgentSessionExitEvent) => void | Promise<void>

// Fired by the runtime on every accepted agent-state phase transition, after the
// liveness and stale-frame guards. Unlike the raw reporter frame, this carries
// state the runtime resolves and the frame cannot: the terminal's `agentId` /
// `executionId`, and `pendingWakeupAt` — the armed self-paced wakeup, which the
// reporter only ever attaches to a PostToolUse frame, never to a turn end.
//
// `event` is the raw reporter event name (`Stop`, `SubagentStop`, `session.idle`,
// …) and is deliberately not collapsed into `phase`: several distinct events map
// to the same phase, so a phase-only signal cannot tell a session's turn end from
// a subagent's, nor an OpenCode idle from an OpenCode crash. Read it through the
// `isAgentTurnEndEvent` / `isAgentTurnFailureEvent` predicates in
// `src/main/agent-state.ts`, never by comparing event names at the call site.
export type AgentPhaseEvent = {
  workspaceId: string | null
  agentId: string
  executionId: string | null
  phase: AgentPhase
  previousPhase: AgentPhase | null
  event: string | null
  ts: number
  // Epoch ms of a self-scheduled wakeup the agent intends to resume at, or null.
  pendingWakeupAt: number | null
  // Present only on a Claude turn end that carried one. Untrusted reporter input.
  transcriptPath?: string
}

export type AgentPhaseListener = (event: AgentPhaseEvent) => void | Promise<void>
