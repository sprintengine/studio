import type {
  SprintEngineAutoState,
  SprintEngineAutomationMode,
  SprintEngineRunnerPolicy,
} from '../types/workspace'

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
  runnerPolicy?: SprintEngineRunnerPolicy | null,
): SprintEngineAutomationMode {
  if (autoState?.autoApproveArtifacts) return 'run_agents_and_approve_artifacts'
  if (autoState?.supervisorEnabled || autoState?.enabled || runnerPolicy?.mode === 'auto') return 'run_agents'
  return 'manual'
}

export function sprintEngineRunnerModeForAutomationMode(
  mode: SprintEngineAutomationMode,
): SprintEngineRunnerPolicy['mode'] {
  return mode === 'manual' ? 'off' : 'auto'
}

export function patchSprintEngineAutoStateForMode(
  current: SprintEngineAutoState,
  mode: SprintEngineAutomationMode,
): SprintEngineAutoState {
  const enabled = mode !== 'manual'
  return {
    ...current,
    supervisorEnabled: enabled,
    enabled,
    autoApproveArtifacts: mode === 'run_agents_and_approve_artifacts',
    pendingSpawns: enabled ? current.pendingSpawns : [],
  }
}
