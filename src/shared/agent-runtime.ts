import type { AgentSessionSystem } from './electron-api'

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
// on `system` to react only to their own executions.
export type AgentSessionExitEvent = {
  system: AgentSessionSystem
  workspaceRoot: string
  workspaceId?: string
  executionId: string
  exitCode: number
}

export type AgentSessionExitListener = (event: AgentSessionExitEvent) => void | Promise<void>
