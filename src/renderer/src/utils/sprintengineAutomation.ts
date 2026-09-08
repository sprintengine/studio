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
    hint: 'Spawn and monitor sprint agents while artifact approvals stay manual.',
  },
  {
    value: 'run_agents_and_approve_artifacts',
    label: sprintEngineAutomationModeLabel('run_agents_and_approve_artifacts'),
    hint: 'Run sprint agents and approve eligible review artifacts automatically.',
  },
]

export function deriveSprintEngineAutomationMode(
  autoState: Partial<SprintEngineAutoState> | null | undefined,
  // `runnerPolicy` is intentionally unused for deriving the live UI / supervisor
  // automation mode. The local `autoState` mirror is the display source of
  // truth (backed by the main-owned intent since MC-1567); `runnerPolicy.
  // cliWatchPolling` is a persisted side-effect written by the main set-mode
  // path for headless CLI agents only. Reading it back here would let stale
  // persisted state override the user's live choice — for example, the Manual
  // radio flicking back to "Run agents + approve artifacts" while the
  // projection refresh catches up after a click. The parameter stays in the
  // signature so call sites keep the fluent shape.
  _runnerPolicy?: SprintEngineRunnerPolicy | null,
): SprintEngineAutomationMode {
  return deriveSprintEngineAutomationDesiredMode(autoState)
}
