import { createSprintEngineTemplate, sprintEngineModuleFromCreatedRun } from '../../../../modules/sprint-engine-workspace-types'
import {
  PlanSourcedSprintEngineWorkspaceError,
  createPlanSourcedSprintEngineWorkspace,
} from '../../../../utils/sprintengineWorkspaceCreation'
import { rendererSprintEngineWorkspaceCreationPort } from '../../../../utils/sprintengineWorkspaceCreationPorts'
// The goal-sourced composition relocated to shared with MC-2160 (main creates
// sprints headlessly). This controller is the wizard's wrapper over it: it adds
// the layout template `OnCreateArgs` carries, which is a window concern.
import {
  buildSprintEngineEffectiveSpawnAtStartRoles,
  clampSprintEngineMaxParallelAgents,
  runSprintEngineNewTeamCreation as composeAndInitSprintEngineNewTeam,
  sprintEngineAutoStateFromRunOptions,
  type SprintEngineNewTeamCreation,
} from '../../../../../../shared/sprintengine/new-team-creation'
import type {
  OnCreateArgs,
  SprintEngineNewTeamInput,
  SprintEngineNewTeamPorts,
  SprintEnginePlanSourcedInput,
  SprintEnginePlanSourcedPorts,
} from '../../../../modules/sprint-engine-workspace-types'

export { buildSprintEngineEffectiveSpawnAtStartRoles }

class SprintEnginePlanSourcedError extends Error {
  constructor(public readonly code:
    | 'missing-folder'
    | 'missing-plan-option'
    | 'missing-plan-content'
    | 'missing-team-name'
    | 'plan-not-on-disk'
    | 'team-exists'
    // Advanced setup (MC-2124) refused: `message` carries the seam's own
    // actionable text, which is what the surface shows.
    | 'advanced-setup-failed'
    | 'unknown'
  ) {
    super(code)
    this.name = 'SprintEnginePlanSourcedError'
  }
}

// The wizard's shape of a composed goal-sourced run: the shared composition plus
// the layout template the workspace is minted from.
function toOnCreateArgs(created: SprintEngineNewTeamCreation): OnCreateArgs {
  return {
    template: createSprintEngineTemplate({
      name: created.sprintEngineState.name,
      goal: created.sprintEngineState.goal,
      roleCounts: created.sprintEngineState.roleCounts,
    }),
    name: created.name,
    folderPath: created.folderPath,
    sprintEngineModule: sprintEngineModuleFromCreatedRun(created),
    sprintEngineRoleModelOverrides: created.roleModelOverrides,
    sprintEngineInitialSpawnRoles: created.initialSpawnRoles,
    sprintEngineAutoState: created.sprintEngineAutoState,
  }
}

export async function runSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamInput,
  ports: SprintEngineNewTeamPorts,
): Promise<OnCreateArgs> {
  return toOnCreateArgs(await composeAndInitSprintEngineNewTeam(input, ports))
}

// What a plan-sourced creation hands back: enough identity for the caller to
// route AFTER the workspace exists (e.g. the New sprint dialog returning a
// door-started creation to the Sprints door on its new run).
export type SprintEnginePlanSourcedCreated = {
  workspaceId: string
  statePath: string
  teamSlug: string
}

export async function runSprintEnginePlanSourcedCreation(
  input: SprintEnginePlanSourcedInput,
  ports: SprintEnginePlanSourcedPorts,
): Promise<SprintEnginePlanSourcedCreated> {
  if (!input.folderPath) throw new SprintEnginePlanSourcedError('missing-folder')
  // For an epic, the epic file itself is the primary handover source and the
  // bundle holds its children. For every other launch the selected plan path is
  // the primary when the caller set one — a bundle may carry supporting items
  // (attached mockups, sibling docs) whose first entry must never displace the
  // selected source. Only a bundle-only launch (no plan path, e.g. a hand-picked
  // HTML mockup) promotes its first item to primary.
  const isEpicSource = input.sourcePlanKind === 'epic'
  const bundlePrimary = !isEpicSource && !input.sourcePlanPath
    ? (input.sourceBundle?.[0] ?? null)
    : null
  const optionRelativePath = bundlePrimary
    ? bundlePrimary.sourceRelativePath
    : input.sourcePlanRelativePath
  const optionPath = bundlePrimary ? bundlePrimary.sourcePath : input.sourcePlanPath
  if (!optionPath || !optionRelativePath) throw new SprintEnginePlanSourcedError('missing-plan-option')
  if (input.sourcePlanContent == null) throw new SprintEnginePlanSourcedError('missing-plan-content')
  if (!input.teamName.trim()) throw new SprintEnginePlanSourcedError('missing-team-name')

  if (!(await ports.pathExists(optionPath))) {
    throw new SprintEnginePlanSourcedError('plan-not-on-disk')
  }

  // Advanced setup runs BEFORE the first mutation (MC-2124), so a refusal
  // leaves no half-configured run behind — the reason the seam returns a
  // message instead of throwing.
  if (ports.persistAdvancedSetup) {
    const advancedSetupError = await ports.persistAdvancedSetup(input.folderPath)
    if (advancedSetupError) {
      const failure = new SprintEnginePlanSourcedError('advanced-setup-failed')
      failure.message = advancedSetupError
      throw failure
    }
  }

  try {
    const result = await createPlanSourcedSprintEngineWorkspace({
      rootPath: input.folderPath,
      teamName: input.teamName,
      goal: input.goal,
      sourcePath: optionRelativePath,
      sourceContent: input.sourcePlanContent,
      sourcePlanKind: input.sourcePlanKind,
      sourceBundle: input.sourceBundle ?? undefined,
      roleCounts: input.visibleRoleCounts,
      roleCliDefaults: input.roleCliDefaults,
      roleModelOverrides: input.roleModelOverrides ?? null,
      roleReasoningOverrides: input.roleReasoningOverrides ?? null,
      initialSpawnRoles: input.initialSpawnRoles ?? null,
      // The run's phase list — forwarded exactly like the new-team path.
      ...(input.defaultPhases !== undefined ? { defaultPhases: input.defaultPhases } : {}),
      workspaceWindowId: input.workspaceWindowId,
      useWorktrees: input.useWorktrees === true,
      taskIsolation: input.taskIsolation === true,
      sourceReference: input.sourceReference === true,
      // Only when the caller chose; absent leaves the default with the engine.
      ...(input.intake ? { intake: input.intake } : {}),
      sprintEngineAutoState: {
        ...sprintEngineAutoStateFromRunOptions(input),
        cliPermissionPreset: input.cliPermissionPreset,
        maxConcurrentAgents: clampSprintEngineMaxParallelAgents(input.maxParallelAgents),
      },
      pathExists: ports.pathExists,
      initializeSprintEngineState: ports.initializeSprintEngineState,
      workspace: rendererSprintEngineWorkspaceCreationPort,
    })
    if (ports.recordBacklogExecutionLink && optionRelativePath.startsWith('backlog/')) {
      await ports.recordBacklogExecutionLink({
        workspaceRoot: input.folderPath,
        sourceRelativePath: optionRelativePath,
        teamSlug: result.sprintEngineContext.teamSlug,
        statePath: result.sprintEngineContext.statePath,
        // Epic children ride the link write for BOTH shapes that carry them:
        // the single-epic launch AND the multi-selection (planKind
        // 'selection'). Gating on epic alone silently dropped the pending
        // child links a dialog multi-select computed, while the MCP selection
        // path wrote them — the two surfaces diverged (integration review,
        // 2026-08-05).
        ...(isEpicSource || input.sourcePlanKind === 'selection'
          ? { childRelativePaths: (input.epicChildRelativePaths ?? []).filter((path) => path.startsWith('backlog/')) }
          : {}),
      })
    }
    return {
      workspaceId: result.workspaceId,
      statePath: result.sprintEngineContext.statePath,
      teamSlug: result.sprintEngineContext.teamSlug,
    }
  } catch (error) {
    if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
      throw new SprintEnginePlanSourcedError('team-exists')
    }
    if (error instanceof Error) {
      const wrapped = new SprintEnginePlanSourcedError('unknown')
      wrapped.message = error.message
      throw wrapped
    }
    throw new SprintEnginePlanSourcedError('unknown')
  }
}
