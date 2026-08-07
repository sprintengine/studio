/**
 * The goal-sourced Sprint Engine creation path (MC-2160).
 *
 * The plan-sourced twin lives in `workspace-creation.ts`; this is the other half
 * — a run created from a bare goal, with no source document behind it. It
 * composes the run state, derives its `run.yaml` location, and drives the
 * one-shot Python init, returning what a caller needs to register the workspace.
 *
 * It lived in the wizard's `sprintEngineController.ts` until main began
 * composing `sprint.create` headlessly. Nothing here is renderer-specific: the
 * two impure steps (does the team directory already exist, run the engine init)
 * were already injected ports, so this is a relocation.
 * `sprintEngineController.ts` re-exports it and adds the wizard's layout
 * template on top.
 */
import type {
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../renderer/src/types/workspace'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
} from '../electron-api'
import type { SprintEngineAutomationMode, SprintEngineCliPermissionPreset } from './automation-types'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from './automation-lifecycle'
import {
  createInitialSprintEngineState,
  normalizeSprintEngineProjection,
  sprintEngineCoordinatorSeatForRoleCounts,
  sprintEngineEnabledRoles,
  sprintEngineRoleKey,
} from './state'
import { getSprintEngineDirectoryPath, getSprintEngineStateFilePath, slugifySprintEngineName } from './state-file'
import { buildSprintEngineRoleRuntimes } from './workspace-creation'

export class SprintEngineNewTeamCreationError extends Error {
  constructor(public readonly code:
    | 'missing-folder'
    | 'team-exists'
    | 'init-failed'
    | 'invalid-projection'
    | 'unknown'
  ) {
    super(code)
    this.name = 'SprintEngineNewTeamCreationError'
  }
}

// Workspace-level cap on concurrent agent sessions (MC-1450). The supervisor
// re-clamps on read, so this only shapes what gets stored.
export const SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS = 3

export function clampSprintEngineMaxParallelAgents(value: number | null | undefined): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS
  return Math.max(1, Math.min(10, parsed))
}

export function buildSprintEngineEffectiveSpawnAtStartRoles(input: {
  automationMode: SprintEngineAutomationMode
  existingTeam: boolean
  visibleRoleCounts: SprintEngineRoleCounts
}): Partial<Record<SprintEngineRoleId, boolean>> {
  // Lazy roster: only the coordinator seat carries a start-at-launch intent —
  // the architect when the selection staffs one, otherwise the roleless seat,
  // keyed by `sprintEngineRoleKey` because it has no role to key on. Worker ids
  // are minted task-scoped and reviewer ids register on first gate, so there is
  // no per-role "Start now" toggle — the seat just bootstraps a non-manual
  // new-team run so an agent is awake to plan it.
  if (input.automationMode !== 'manual' && !input.existingTeam) {
    const seat = sprintEngineCoordinatorSeatForRoleCounts(input.visibleRoleCounts)
    return { [sprintEngineRoleKey(seat.role)]: true }
  }
  return {}
}

export function sprintEngineAutoStateFromRunOptions(input: {
  startRunner: boolean
  autoApproveArtifacts: boolean
}): Partial<SprintEngineAutoState> {
  return sprintEngineAutomationInitialStateForMode(sprintEngineAutomationModeForRunOptions(input))
}

// Lived in useNewWorkspaceFolder until the wizard's sprint flow was deleted
// (MC-2062).
export function buildSprintEngineContext(
  folderPath: string,
  teamName: string,
  teamSlug: string,
): SprintEngineWorkspaceContext {
  return {
    teamName,
    teamSlug,
    teamDirectoryPath: getSprintEngineDirectoryPath(folderPath, teamSlug),
    statePath: getSprintEngineStateFilePath(folderPath, teamSlug),
  }
}

export type SprintEngineNewTeamCreationInput = {
  folderPath: string | null
  teamName: string
  goal: string
  /** The roster that actually staffs the run. */
  visibleRoleCounts: SprintEngineRoleCounts
  /** Workspace-level cap on concurrent agent sessions (MC-1450). Clamped 1-10. */
  maxParallelAgents: number
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees?: boolean
  taskIsolation?: boolean
  repos?: Array<{ id: string; root: string }>
  /** Present only when it diverges from the engine default. */
  defaultPhases?: string[]
  cliPermissionPreset: SprintEngineCliPermissionPreset
}

/** What a composed goal-sourced run hands back for workspace registration. */
export type SprintEngineNewTeamCreation = {
  name: string
  folderPath: string | null
  sprintEngineState: SprintEngineState
  sprintEngineContext: SprintEngineWorkspaceContext | null
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides | null
  initialSpawnRoles: SprintEngineRoleId[] | null
  sprintEngineAutoState: Partial<SprintEngineAutoState>
}

export type SprintEngineNewTeamCreationPorts = {
  pathExists?: (path: string) => Promise<boolean> | boolean
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
}

export function buildSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamCreationInput,
): SprintEngineNewTeamCreation {
  const sprintEngineState = createInitialSprintEngineState({
    name: input.teamName.trim() || 'Sprint Roster',
    goal: input.goal.trim(),
    roleCounts: input.visibleRoleCounts,
  })
  if (input.useWorktrees) {
    sprintEngineState.useWorktrees = true
  }
  const sprintEngineContext = input.folderPath
    ? buildSprintEngineContext(
      input.folderPath,
      sprintEngineState.name,
      slugifySprintEngineName(sprintEngineState.name),
    )
    : null
  return {
    name: sprintEngineState.name,
    folderPath: input.folderPath,
    sprintEngineState,
    sprintEngineContext,
    roleCliDefaults: input.roleCliDefaults,
    roleModelOverrides: input.roleModelOverrides ?? null,
    initialSpawnRoles: input.initialSpawnRoles ?? null,
    sprintEngineAutoState: {
      ...sprintEngineAutoStateFromRunOptions(input),
      cliPermissionPreset: input.cliPermissionPreset,
      maxConcurrentAgents: clampSprintEngineMaxParallelAgents(input.maxParallelAgents),
    },
  }
}

function parseInitializedSprintEngineState(input: unknown, fallbackName: string): SprintEngineState | null {
  if (!input || typeof input !== 'object') return null
  const projectionContent = (input as { projectionContent?: unknown }).projectionContent
  if (typeof projectionContent !== 'string' || !projectionContent.trim()) return null
  try {
    return normalizeSprintEngineProjection(JSON.parse(projectionContent) as unknown, fallbackName)
  } catch {
    return null
  }
}

export async function runSprintEngineNewTeamCreation(
  input: SprintEngineNewTeamCreationInput,
  ports: SprintEngineNewTeamCreationPorts,
): Promise<SprintEngineNewTeamCreation> {
  if (!input.folderPath) throw new SprintEngineNewTeamCreationError('missing-folder')

  const args = buildSprintEngineNewTeamCreation(input)
  if (!args.sprintEngineContext || !args.sprintEngineState) {
    throw new SprintEngineNewTeamCreationError('missing-folder')
  }
  if (ports.pathExists && await ports.pathExists(args.sprintEngineContext.statePath)) {
    throw new SprintEngineNewTeamCreationError('team-exists')
  }

  try {
    const initResult = await ports.initializeSprintEngineState({
      statePath: args.sprintEngineContext.statePath,
      name: args.sprintEngineState.name,
      goal: args.sprintEngineState.goal,
      agents: args.sprintEngineState.sprintEngineAgents,
      tasks: args.sprintEngineState.tasks,
      events: args.sprintEngineState.events,
      artifacts: args.sprintEngineState.artifacts,
      useWorktrees: input.useWorktrees === true,
      // Per-task worktrees (MC-2136), only ever alongside run worktrees — the
      // engine refuses the pair, and absent keeps the payload as it was.
      ...(input.useWorktrees === true && input.taskIsolation === true ? { taskIsolation: true } : {}),
      // The other projects this run also works in (item 1765), declared here so a
      // multi-project run has every worktree the moment it initializes. Only ever
      // present alongside worktree mode — the engine refuses the pair, and the
      // wizard drops the selection when the toggle goes off. Mid-run additions
      // still arrive through `sprintengine.vcs.request_repo`; this is the set the
      // operator already knew about.
      ...(input.useWorktrees === true && input.repos && input.repos.length > 0
        ? { repos: input.repos }
        : {}),
      // Record the roster's per-role model selection so claimed tasks get
      // stamped with the model that worked them, and its effort level so every
      // spawn of the role launches at it (same as the plan-sourced path).
      roleRuntimes: buildSprintEngineRoleRuntimes(
        input.roleModelOverrides,
        input.roleCliDefaults,
        input.roleReasoningOverrides,
      ),
      // Persist the enabled role set (init `configuredRoles`, the run's legal
      // role set for plan.add_task/seating) covering the configured-but-not-
      // yet-seated roles under the lazy roster.
      enabledRoles: sprintEngineEnabledRoles(args.sprintEngineState.roleCounts),
      // The run's phase list. The wizard omits it when it is at its default, so
      // forward it only when actually set — a plain run stays byte-identical.
      ...(input.defaultPhases !== undefined ? { defaultPhases: input.defaultPhases } : {}),
    })
    if (!initResult.ok) {
      const wrapped = new SprintEngineNewTeamCreationError('init-failed')
      wrapped.message = initResult.message || 'Could not initialize sprint run state.'
      throw wrapped
    }

    const initializedState = parseInitializedSprintEngineState(
      initResult.data,
      args.sprintEngineState.name,
    )
    if (!initializedState) {
      throw new SprintEngineNewTeamCreationError('invalid-projection')
    }

    return { ...args, sprintEngineState: initializedState }
  } catch (error) {
    if (error instanceof SprintEngineNewTeamCreationError) throw error
    const wrapped = new SprintEngineNewTeamCreationError('unknown')
    wrapped.message = error instanceof Error ? error.message : String(error)
    throw wrapped
  }
}
