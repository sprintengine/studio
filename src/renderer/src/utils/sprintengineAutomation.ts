import type {
  SprintEngineAutoState,
  SprintEngineAutomationMode,
  SprintEngineRunnerPolicy,
} from '../types/workspace'
import { deriveSprintEngineAutomationDesiredMode } from './sprintengineAutomationLifecycle'

export const sprintEngineAutomationModeOptions: Array<{
  value: SprintEngineAutomationMode
  label: string
  hint: string
}> = [
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Do not spawn agents or approve artifacts automatically.',
  },
  {
    value: 'run_agents',
    label: 'Run agents',
    hint: 'Spawn and monitor roster agents while artifact approvals stay manual.',
  },
  {
    value: 'run_agents_and_approve_artifacts',
    label: 'Run agents + approve artifacts',
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

export function sprintEngineCliWatchPollingForAutomationMode(
  mode: SprintEngineAutomationMode,
): SprintEngineRunnerPolicy['cliWatchPolling'] {
  // Manual = headless `join --watch` exits when idle; any automation mode =
  // headless `join --watch` keeps polling. The Multicode supervisor itself
  // does not consult this value, but we bridge it so a headless CLI agent
  // opened against the same run respects the user's intent.
  return mode === 'manual' ? 'disabled' : 'enabled'
}

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
