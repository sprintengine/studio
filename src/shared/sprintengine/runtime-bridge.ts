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
 *    the UI reflects scheduling live (agent launch flags, stop reasons,
 *    roster-session records, retirements).
 */
import type {
  SprintEngineAutomationRuntimeState,
  SprintEngineAutomationStopReason,
  SprintEngineCliPermissionPreset,
} from './automation-types'
import type { SprintEngineRosterSession } from './run-types'
import type { AgentState } from './agent-state'
import type { DiagnosticLogEntry } from '../electron-api'

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
   * registration so an in-flight run migrates cleanly (delivered notification
   * keys, the one-shot completion-teardown marker).
   */
  deliveredAgentNotificationEventKeys: string[]
  completionTeardownAt?: number
  /**
   * Renderer-persisted automation lifecycle, adopted (like the residue above)
   * on first registration only. When main later adopts the sidecar's desired
   * mode it preserves this runtime state instead of forcing `running`, so an
   * app relaunch never auto-resumes a run the user saw paused/blocked/failed
   * and never re-activates a completed one. Absent (older window build or no
   * meaningful lifecycle) falls back to `running` for enabling modes.
   */
  runtimeState?: SprintEngineAutomationRuntimeState
  reason?: SprintEngineAutomationStopReason
  reasonMessage?: string
  reasonTaskId?: string
  reasonAgentId?: string
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

/**
 * Per-agent renderer-owned config. `null` is an explicit tombstone ("the user
 * cleared this") — distinct from an absent field, which means "this window has
 * no opinion" and never clears main's copy. `configEditedAt` mirrors the agent
 * record's stamp; main applies a config only when it is not older than the
 * last one applied, so a lagging window's re-registration cannot clobber a
 * newer edit from another window.
 */
export type SprintRuntimeAgentConfig = {
  cliRuntimeOverride?: { cli?: string; model?: string | null } | null
  name?: string
  cliStartupPrompt?: string | null
  configEditedAt?: number
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
  /**
   * A user-facing cycle diagnostic (auto-approval skipped, spawn failed,
   * bootstrap stall…). Main already wrote the JSONL —
   * windows only surface the entry in the in-app notification store, matching
   * the retired renderer supervisor's `publishDiagnostic` behavior.
   */
  | { kind: 'diagnostic'; statePath: string; entry: DiagnosticLogEntry }
  /**
   * Tab maintenance after a scheduler spawn/notification paste: windows with
   * an open tab for the agent rename it to the current task label and
   * re-stamp its config (sessionId), exactly like the retired supervisor's
   * `applyAgentTerminalRevealPolicy(..., 'background')` call. Never opens a
   * new tab.
   */
  | {
    kind: 'reveal_policy'
    statePath: string
    agentId: string
    name: string
    revealPolicy: 'background' | 'focus-if-open' | 'reveal'
    sessionId?: string
  }
