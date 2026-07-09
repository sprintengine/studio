import type {
  SprintEngineAutoState,
  SprintEngineAutomationMode,
  SprintEngineRunnerPolicy,
} from '../types/workspace'
import { sprintEngineAutomationModeLabel } from '../../../shared/sprintengine/automation-types'
import { deriveSprintEngineAutomationDesiredMode } from './sprintengineAutomationLifecycle'

// Labels come from the shared automation vocabulary so the main-process audit
// and the renderer UI can never drift; the hints are UI-only copy.
export const sprintEngineAutomationModeOptions: Array<{
  value: SprintEngineAutomationMode
  label: string
  hint: string
}> = [
  {
    value: 'manual',
    label: sprintEngineAutomationModeLabel('manual'),
    hint: 'Do not spawn agents or approve artifacts automatically.',
  },
  {
    value: 'run_agents',
    label: sprintEngineAutomationModeLabel('run_agents'),
    hint: 'Spawn and monitor roster agents while artifact approvals stay manual.',
  },
  {
    value: 'run_agents_and_approve_artifacts',
    label: sprintEngineAutomationModeLabel('run_agents_and_approve_artifacts'),
    hint: 'Run roster agents and approve eligible review artifacts automatically.',
  },
]

export function deriveSprintEngineAutomationMode(
  autoState: Partial<SprintEngineAutoState> | null | undefined,
  // `runnerPolicy` is intentionally unused for deriving the live UI / supervisor
  // automation mode. The local `autoState` is the source of truth for user
  // intent; `runnerPolicy.mode` is a persisted side-effect that the supervisor
  // and click handlers write to via `setSprintEngineRunnerMode`. Reading it
  // back here would let stale persisted state override the user's live choice
  // — for example, the Manual radio flicking back to "Run agents + approve
  // artifacts" while the projection refresh catches up after a click. The
  // parameter stays in the signature so call sites keep the fluent shape and a
  // future workspace-load-time hydration step can seed `autoState` from the
  // persisted runner mode in one explicit place.
  _runnerPolicy?: SprintEngineRunnerPolicy | null,
): SprintEngineAutomationMode {
  return deriveSprintEngineAutomationDesiredMode(autoState)
}

// The intent -> headless-CLI polling-flag bridge relocated to the shared
// lifecycle module (MC-1567): the main-process set-mode path is the one writer
// of the run.yaml hint now, and this re-export keeps renderer imports working.
export { sprintEngineCliWatchPollingForAutomationMode } from '../../../shared/sprintengine/automation-lifecycle'

export function patchSprintEngineAutoStateForMode(
  current: SprintEngineAutoState,
  mode: SprintEngineAutomationMode,
): SprintEngineAutoState {
  const enabled = mode !== 'manual'
  return {
    ...current,
    desiredMode: mode,
    runtimeState: enabled ? 'running' : 'idle',
    reason: enabled ? undefined : 'user_selected_manual',
    reasonMessage: enabled ? undefined : 'Switched to manual mode by the user.',
    reasonTaskId: undefined,
    reasonAgentId: undefined,
    changedAt: Date.now(),
    pendingSpawns: enabled ? current.pendingSpawns : [],
  }
}
