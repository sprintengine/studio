import { createSprintEngineTemplate } from '../modules/sprint-engine-workspace-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleModelOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourcePlanKind,
  SprintEngineWorkspaceContext,
  WorkspaceId,
  WorkspaceWindowId,
} from '../types/workspace'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
  SprintEngineStateInitializeSource,
  SprintEngineStateInitializeSourceBundleItem,
} from '../../../shared/electron-api'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  createInitialSprintEngineState,
  sprintEngineEnabledRoles,
  sprintEnginePlannerRole,
} from './sprintengine'
import { buildPlanFileSprintEngineHandoffPrompt } from './sprintengineHandoff'
import { buildRunWorkspaceContext } from './runWorkspaceCreation'
import { deriveSprintEngineAutomationDesiredMode } from './sprintengineAutomationLifecycle'

export type PlanSourcedSprintEngineWorkspaceArgs = {
  rootPath: string
  teamName: string
  goal: string
  sourcePath: string
  sourceContent: string
  sourcePlanKind?: SprintEngineSourcePlanKind
  sourceBundle?: SprintEngineSourceBundleItem[]
  // Required: the caller's configured roster IS the run's roster. There is no
  // default here — a fallback team would staff roles the user never picked.
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults?: SprintEngineRoleCliDefaults
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  // Extra roles merged into enabledRoles -> configuredRoles at init: the sweep
  // roles the user actually selected in the wizard's "Final sweeps" panel. The
  // roster is the user's configuration — an unselected sweep role must not be
  // seated or plannable (the architect raises needs_input if the work needs
  // a role the run doesn't have).
  additionalEnabledRoles?: SprintEngineRoleId[]
  // "Workflow steps" + "Final sweeps" run-init keys (MC-1542 / MC-1543),
  // forwarded verbatim to init; each present only when it diverges from the
  // engine default (same contract as the new-team path).
  defaultPhases?: string[]
  requiredSweeps?: string[]
  phaseRuntimes?: Record<string, { cli: string; model: string | null }>
  sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
  workspaceWindowId?: WorkspaceWindowId | null
  useWorktrees?: boolean
  // Record file-backed sources as project-root-relative references (no copy into
  // the run store). Set for backlog/file-sourced launches so the canonical design
  // docs stay authoritative and are reviewed/updated in place.
  sourceReference?: boolean
  pathExists?: (path: string) => boolean | Promise<boolean>
  initializeSprintEngineState?: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
}

export type PlanSourcedSprintEngineWorkspaceResult = {
  workspaceId: WorkspaceId
  sprintEngineContext: SprintEngineWorkspaceContext
  // The run's planner seat: the general in a general-default run, the architect
  // when the selection staffs one. Carries the startup handoff prompt.
  plannerAgentId: string
}

export class PlanSourcedSprintEngineWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'missing-root'
      | 'missing-team'
      | 'missing-source'
      | 'team-exists'
      | 'missing-planner'
  ) {
    super(code)
    this.name = 'PlanSourcedSprintEngineWorkspaceError'
  }
}

export function buildPlanSourcedSprintEngineWorkspaceContext(
  rootPath: string,
  teamName: string
): SprintEngineWorkspaceContext {
  const context = buildRunWorkspaceContext({
    kind: 'sprintengine',
    rootPath,
    name: teamName,
  })
  return {
    teamName: context.name,
    teamSlug: context.slug,
    teamDirectoryPath: context.directoryPath,
    statePath: context.statePath,
  }
}

// Build the per-role execution runtime map (model/cli) recorded into run state
// at init, so each claimed task can be stamped with the model that worked it.
// Union the roles from both maps; a role with no explicit model is still
// recorded when it has a CLI, and dropped entirely (server-side) when it has
// neither. Used by every Sprint Engine creation path that inits a run.
export function buildSprintEngineRoleRuntimes(
  roleModelOverrides: SprintEngineRoleModelOverrides | null | undefined,
  roleCliDefaults: SprintEngineRoleCliDefaults | null | undefined,
): Record<string, { model?: string | null; cli?: string | null }> {
  const roleRuntimes: Record<string, { model?: string | null; cli?: string | null }> = {}
  for (const role of new Set([
    ...Object.keys(roleModelOverrides ?? {}),
    ...Object.keys(roleCliDefaults ?? {}),
  ])) {
    const model = roleModelOverrides?.[role as SprintEngineRoleId] ?? null
    const cli = roleCliDefaults?.[role as SprintEngineRoleId] ?? null
    if (model || cli) roleRuntimes[role] = { model, cli }
  }
  return roleRuntimes
}

// Build the source seed persisted into run.yaml at creation (reference-mode
// launches only). Mirrors the shape the Python handover command writes so the
// Sprint Inbox shows an honest "Started from" the moment the run exists, before
// any agent runs handover. Paths are the project-root-relative references the
// caller already resolved; `capturedAt` is stamped now (launch time).
function buildSprintEngineInitSourceSeed(
  sourcePath: string,
  sourcePlanKind: SprintEngineSourcePlanKind,
  sourceBundle: SprintEngineSourceBundleItem[] | undefined,
): {
  source: SprintEngineStateInitializeSource
  sourceBundle: SprintEngineStateInitializeSourceBundleItem[]
} {
  const capturedAt = new Date().toISOString()
  return {
    source: {
      kind: 'markdown',
      origin: 'reference',
      path: sourcePath,
      planKind: sourcePlanKind,
      capturedAt,
    },
    sourceBundle: (sourceBundle ?? []).map((item) => ({
      kind: item.kind,
      origin: 'reference',
      path: item.sourceRelativePath,
      capturedAt,
    })),
  }
}

export async function createPlanSourcedSprintEngineWorkspace({
  rootPath,
  teamName,
  goal,
  sourcePath,
  sourceContent,
  sourcePlanKind = 'unknown',
  sourceBundle,
  roleCounts,
  roleCliDefaults,
  roleModelOverrides,
  initialSpawnRoles,
  additionalEnabledRoles,
  defaultPhases,
  requiredSweeps,
  phaseRuntimes,
  sprintEngineAutoState,
  workspaceWindowId,
  useWorktrees,
  sourceReference,
  pathExists,
  initializeSprintEngineState,
}: PlanSourcedSprintEngineWorkspaceArgs): Promise<PlanSourcedSprintEngineWorkspaceResult> {
  const trimmedRoot = rootPath.trim()
  const trimmedTeamName = teamName.trim()
  const trimmedSourcePath = sourcePath.trim()
  const trimmedGoal = goal.trim() || derivePlanSourcedGoal(sourceContent, trimmedSourcePath)

  if (!trimmedRoot) throw new PlanSourcedSprintEngineWorkspaceError('missing-root')
  if (!trimmedTeamName) throw new PlanSourcedSprintEngineWorkspaceError('missing-team')
  if (!trimmedSourcePath) throw new PlanSourcedSprintEngineWorkspaceError('missing-source')

  const sprintEngineContext = buildPlanSourcedSprintEngineWorkspaceContext(trimmedRoot, trimmedTeamName)
  if (pathExists && await pathExists(sprintEngineContext.statePath)) {
    throw new PlanSourcedSprintEngineWorkspaceError('team-exists')
  }

  const sprintEngineState = createInitialSprintEngineState({
    name: sprintEngineContext.teamName,
    goal: trimmedGoal,
    roleCounts,
  })
  // Persisted on workspace state (matching the new-team path) so the auto-run
  // supervisor routes agent terminals into the shared run worktree and later
  // agent prompts keep requesting worktree mode.
  if (useWorktrees === true) {
    sprintEngineState.useWorktrees = true
  }
  // The lazy roster seeds exactly one seat: the run's planner (general in a
  // general-default run, the architect when staffed). Grab it by the same rule
  // the roster used to seat it — a general-only run no longer has an architect.
  const plannerRole = sprintEnginePlannerRole(sprintEngineState.roleCounts)
  const planner = buildSprintEngineAgentRosterForState(sprintEngineState).find((agent) => agent.role === plannerRole)
  if (!planner) throw new PlanSourcedSprintEngineWorkspaceError('missing-planner')

  // The run's legal role set: forwarded to Python init as `configuredRoles`,
  // told to the architect in the startup prompt, and seeded onto the local
  // state so wake prompts built before the first projection refresh carry the
  // same list (the projection then overwrites it with the identical canonical
  // copy). Never derive this from roster seats — the lazy roster seats only
  // the planner.
  const enabledRoles = sprintEngineEnabledRoles(sprintEngineState.roleCounts, additionalEnabledRoles)
  sprintEngineState.configuredRoles = enabledRoles

  // Reference-mode (backlog/plan-sourced) launches seed the source into run.yaml
  // at init, so the run carries its "Started from" seed at t=0 and the architect
  // startup prompt drops the (now redundant, and on a second call erroring)
  // handover step. Copy-mode paths (Guided Brief) still seed via handover.
  const seedSourceAtInit = sourceReference === true && Boolean(initializeSprintEngineState)
  const initSourceSeed = seedSourceAtInit
    ? buildSprintEngineInitSourceSeed(trimmedSourcePath, sourcePlanKind, sourceBundle)
    : null

  if (initializeSprintEngineState) {
    const initResult = await initializeSprintEngineState({
      statePath: sprintEngineContext.statePath,
      name: sprintEngineState.name,
      goal: sprintEngineState.goal,
      agents: sprintEngineState.sprintEngineAgents,
      tasks: sprintEngineState.tasks,
      events: sprintEngineState.events,
      artifacts: sprintEngineState.artifacts,
      useWorktrees: useWorktrees === true,
      roleRuntimes: buildSprintEngineRoleRuntimes(roleModelOverrides, roleCliDefaults),
      enabledRoles,
      // "Workflow steps" + "Final sweeps" keys, present only when set — the
      // plan-sourced path used to drop these, so a mandated sweep never reached
      // run.yaml `requiredSweeps`.
      ...(defaultPhases !== undefined ? { defaultPhases } : {}),
      ...(requiredSweeps !== undefined ? { requiredSweeps } : {}),
      ...(phaseRuntimes !== undefined ? { phaseRuntimes } : {}),
      ...(initSourceSeed
        ? { source: initSourceSeed.source, sourceBundle: initSourceSeed.sourceBundle }
        : {}),
    })
    if (!initResult.ok) {
      throw new Error(initResult.message || 'Could not initialize sprint run state.')
    }
  }

  const template = createSprintEngineTemplate({
    name: sprintEngineState.name,
    goal: sprintEngineState.goal,
    roleCounts: sprintEngineState.roleCounts,
  })
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: sprintEngineContext.teamName,
    folderPath: trimmedRoot,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults: roleCliDefaults,
    sprintEngineRoleModelOverrides: roleModelOverrides,
    sprintEngineInitialSpawnRoles: initialSpawnRoles,
    sprintEngineAutoState,
    windowId: workspaceWindowId,
  })

  const startupPrompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: sprintEngineContext.teamSlug,
    goal: trimmedGoal,
    sourcePath: trimmedSourcePath,
    sourceContent,
    sourcePlanKind,
    sourceBundle,
    statePath: sprintEngineContext.statePath,
    rosterArgs: buildSprintEngineRosterCommandArgs(sprintEngineState),
    configuredRoles: enabledRoles,
    autoRunRequested: deriveSprintEngineAutomationDesiredMode(sprintEngineAutoState) !== 'manual',
    useWorktrees: useWorktrees === true,
    reference: sourceReference === true,
    seedAlreadyPersisted: seedSourceAtInit,
  })

  useWorkspaceStore.getState().updateAgent(workspaceId, planner.id, {
    cliStartupPrompt: startupPrompt,
    cliOnboardingPromptSent: false,
  })

  return {
    workspaceId,
    sprintEngineContext,
    plannerAgentId: planner.id,
  }
}

function derivePlanSourcedGoal(sourceContent: string, sourcePath: string): string {
  const heading = sourceContent
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,3}\s+(.+?)\s*$/u)?.[1]?.trim())
    .find((title): title is string => Boolean(title))
  if (heading) return heading

  const filename = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = filename.replace(/\.[^.]+$/u, '').trim()
  const normalized = stem.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized || 'Sprint handoff'
}
