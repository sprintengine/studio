/**
 * Contract between the main-process sprint scheduler (`src/main/
 * sprint-runtime.ts`) and its renderer bridge (sprint-runtime-ownership
 * Phase 2).
 *
 * Ownership model: main owns the auto-run *decisions* (the shared cycle in
 * `auto-run-cycle.ts` driven by main ports against a main-held run view); the
 * renderer owns *display* and window-scoped concerns (tabs, terminal views,
 * store persistence). Three flows cross the boundary:
 *
 * 1. **Run registration (renderer -> main)**: the renderer announces each
 *    sprint workspace's identity + run configuration so main can build its run
 *    view (main cannot read renderer localStorage). Re-sent on change;
 *    idempotent upserts.
 * 2. **Lifecycle pushes (renderer -> main)**: renderer-originated automation
 *    stop reasons (user closed an agent terminal, workspace removed) so the
 *    scheduler pauses in step with the UI.
 * 3. **Runtime ops (main -> renderer broadcast)**: store mutations the cycle
 *    performed against main's run view, mirrored into every window's store so
 *    the UI reflects scheduling live (agent launch flags, pending spawns,
 *    stop reasons, roster-session records, retirements).
 */
import type {
  SprintEngineAutoPendingSpawn,
  SprintEngineCliPermissionPreset,
} from './automation-types'
import type { SprintEngineRosterSession } from './run-types'
import type { AgentState } from './agent-state'

export const SPRINT_RUNTIME_OP_CHANNEL = 'sprintengine:runtime-op'

/** Renderer -> main: announce/refresh a sprint run's context. */
export type SprintRuntimeRunRegistration = {
  statePath: string
  workspaceId: string
  workspaceName: string
  folderPath: string
  /** Optional project-memory relative root (workspace.memory.relativeRoot). */
  memoryRelativeRoot: string | null
  /** Renderer-owned run configuration the scheduler honours. */
  cliPermissionPreset: SprintEngineCliPermissionPreset
  maxConcurrentAgents: number
  architectGuidance?: string
  /**
   * Renderer-persisted runtime residue the scheduler adopts on first
   * registration so an in-flight run migrates cleanly (pending spawns dedup
   * markers, delivered notification keys, the one-shot completion-teardown
   * marker).
   */
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  deliveredAgentNotificationEventKeys: string[]
  completionTeardownAt?: number
  /** Resume tokens for roster agents (renderer store `sprintEngineRosterSessions`). */
  rosterSessions: Record<string, SprintEngineRosterSession>
  /** Current agent records so main's view starts from what the UI shows. */
  agents: Record<string, AgentState>
  /**
   * User-editable per-agent configuration (mid-run runtime override, rename,
   * queued custom startup prompt). Unlike the residue above, these are
   * RENDERER-owned and re-pushed on change — main merges them into its view
   * on every registration so the next spawn honours them.
   */
  agentConfigs: Record<string, SprintRuntimeAgentConfig>
}

export type SprintRuntimeAgentConfig = {
  cliRuntimeOverride?: { cli?: string; model?: string | null }
  name?: string
  cliStartupPrompt?: string
}

export type SprintRuntimeStopReasonPush = {
  statePath: string
  reason:
    | 'user_manual_toggle'
    | 'folder_missing'
    | 'blocked_on_external_input'
    | 'all_tasks_done'
    | 'workspace_removed'
    | 'agent_terminal_closed'
    | 'agent_spawn_failed'
  context?: { taskId?: string; agentId?: string; message?: string; details?: string }
}

/** Main -> renderer broadcast: one store mutation performed by the scheduler. */
export type SprintRuntimeOp =
  | { kind: 'agent_updated'; statePath: string; agentId: string; update: Partial<AgentState> }
  | { kind: 'assign_session'; statePath: string; agentId: string; sessionId: string; cli: string }
  | {
    kind: 'launch_state'
    statePath: string
    agentId: string
    update: {
      cliSessionId?: string | null
      cliStartRequested?: boolean
      cliHasLaunched?: boolean
      cliOnboardingPromptSent?: boolean
      cliResumeAvailable?: boolean
    }
  }
  | { kind: 'pending_spawns'; statePath: string; pendingSpawns: SprintEngineAutoPendingSpawn[] }
  | { kind: 'notification_delivered'; statePath: string; eventKey: string }
  | { kind: 'folder_missing'; statePath: string; missing: boolean }
  | {
    kind: 'stop_reason'
    statePath: string
    reason: SprintRuntimeStopReasonPush['reason']
    context?: SprintRuntimeStopReasonPush['context']
  }
  | { kind: 'roster_session_recorded'; statePath: string; agentId: string; session: SprintEngineRosterSession }
  | {
    kind: 'worker_retired'
    statePath: string
    agentId: string
    closedSessionId: string | null
  }
  | { kind: 'completion_teardown_at'; statePath: string; at: number | undefined }
