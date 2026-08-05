import { createSprintEngineTemplate } from '../modules/sprint-engine-workspace-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
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
import { derivePlanSourcedGoal } from './sprintengineTrackerSeeding'
import { resolveChainedSprintTeamName } from './chainedSprintTeamName'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  createInitialSprintEngineState,
  sprintEngineCoordinatorSeatForRoleCounts,
  sprintEngineEnabledRoles,
} from './sprintengine'
import type { SprintEngineIntake } from '../../../shared/sprintengine/run-types'
import { sourcePlanKindSupportsDirectIntake } from '../../../shared/sprintengine/run-types'
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
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides | null
  initialSpawnRoles?: SprintEngineRoleId[] | null
  // The run's post-implementation phase list, forwarded verbatim to init; present
  // only when it diverges from the engine default (same contract as the new-team
  // path).
  defaultPhases?: string[]
  sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
  workspaceWindowId?: WorkspaceWindowId | null
  useWorktrees?: boolean
  // The other projects this run also changes (MC-1613). Forwarded verbatim to
  // init as `--repo <id>=<root>`; only meaningful alongside useWorktrees.
  repos?: Array<{ id: string; root: string }>
  // Worktree start point for chained runs on a refreshed base (MC-1438), e.g.
  // `origin/main` after a fetch. Forwarded verbatim to init; the run's PR base
  // stays the plain branch name. Only meaningful alongside useWorktrees.
  baseStartPoint?: string
  // Record file-backed sources as project-root-relative references (no copy into
  // the run store). Set for backlog/file-sourced launches so the canonical design
  // docs stay authoritative and are reviewed/updated in place.
  sourceReference?: boolean
  // How the run gets its task graph (MC-2128). Omit to let the engine apply its
  // per-source default — `direct` for an epic, `planned` for everything else.
  intake?: SprintEngineIntake
  pathExists?: (path: string) => boolean | Promise<boolean>
  initializeSprintEngineState?: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
}

export type PlanSourcedSprintEngineWorkspaceResult = {
  workspaceId: WorkspaceId
  sprintEngineContext: SprintEngineWorkspaceContext
  // The run's coordinator seat: the roleless `coordinator` when the selection
  // staffs no architect, the architect when it does. Carries the startup
  // handoff prompt.
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

// Build the per-role execution runtime map (model/cli/reasoning effort) recorded
// into run state at init, so each claimed task can be stamped with the model that
// worked it and every spawn of the role carries the level the roster picked.
// Union the roles from all three maps; a role with no explicit model is still
// recorded when it has a CLI, and dropped entirely (server-side) when it has
// neither. A reasoning level alone never mints an entry — a level without a CLI
// has nothing to launch — so it rides the roles the CLI/model maps already name.
// Used by every Sprint Engine creation path that inits a run.
export function buildSprintEngineRoleRuntimes(
  roleModelOverrides: SprintEngineRoleModelOverrides | null | undefined,
  roleCliDefaults: SprintEngineRoleCliDefaults | null | undefined,
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides | null,
): Record<string, { model?: string | null; cli?: string | null; reasoning?: string | null }> {
  const roleRuntimes: Record<string, { model?: string | null; cli?: string | null; reasoning?: string | null }> = {}
  for (const role of new Set([
    ...Object.keys(roleModelOverrides ?? {}),
    ...Object.keys(roleCliDefaults ?? {}),
  ])) {
    const model = roleModelOverrides?.[role as SprintEngineRoleId] ?? null
    const cli = roleCliDefaults?.[role as SprintEngineRoleId] ?? null
    const reasoning = roleReasoningOverrides?.[role as SprintEngineRoleId] ?? null
    // A recorded role MUST carry a CLI. Roles supplied by the role registry
    // (e.g. nuclear_reviewer, spec_reviewer) are absent from
    // DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, so DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS
    // (derived from its keys) has no baseline entry for them. A model-only pick
    // then reaches here with cli:null and persists into run.yaml `roleRuntimes`
    // as `{model, cli:null}`, which hard-fails spawnAutoRunCandidate — it has no
    // 'claude-code' fallback the way reconcileSprintEngineAgents does, so the
    // roster runner stalls the task (and, via the tick's early return on a failed
    // spawn, every sibling behind it) and spams the diagnostics log. Default the
    // CLI whenever an entry is recorded so a runnable role never ships without one.
    if (model || cli) {
      roleRuntimes[role] = { model, cli: cli ?? 'claude-code', ...(reasoning ? { reasoning } : {}) }
    }
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
      // Carried into run.yaml so the planner can enumerate the epic's children
      // one-to-one and plan approval can warn about one it left undelivered.
      ...(item.epicChild === true ? { epicChild: true } : {}),
      // The selection counterpart (MC-2060): a directly-selected work item.
      ...(item.selectedItem === true ? { selectedItem: true } : {}),
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
  roleReasoningOverrides,
  initialSpawnRoles,
  defaultPhases,
  sprintEngineAutoState,
  workspaceWindowId,
  useWorktrees,
  repos,
  baseStartPoint,
  sourceReference,
  intake,
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
  // The lazy roster seeds exactly one seat: the run's coordinator. Grab it by
  // ID rather than by role — a roleless run's seat has no role to match on.
  const seat = sprintEngineCoordinatorSeatForRoleCounts(sprintEngineState.roleCounts)
  const planner = buildSprintEngineAgentRosterForState(sprintEngineState).find((agent) => agent.id === seat.agentId)
  if (!planner) throw new PlanSourcedSprintEngineWorkspaceError('missing-planner')

  // The run's legal role set: forwarded to Python init as `configuredRoles`,
  // told to the architect in the startup prompt, and seeded onto the local
  // state so wake prompts built before the first projection refresh carry the
  // same list (the projection then overwrites it with the identical canonical
  // copy). Never derive this from roster seats — the lazy roster seats only
  // the coordinator.
  const enabledRoles = sprintEngineEnabledRoles(sprintEngineState.roleCounts)
  sprintEngineState.configuredRoles = enabledRoles

  // Reference-mode (backlog/plan-sourced) launches seed the source into run.yaml
  // at init, so the run carries its "Started from" seed at t=0 and the architect
  // startup prompt drops the (now redundant, and on a second call erroring)
  // handover step. Copy-mode paths (Guided Brief) still seed via handover.
  const seedSourceAtInit = sourceReference === true && Boolean(initializeSprintEngineState)
  const initSourceSeed = seedSourceAtInit
    ? buildSprintEngineInitSourceSeed(trimmedSourcePath, sourcePlanKind, sourceBundle)
    : null

  // Whether THIS run will plan (MC-2128). Mirrors the engine's own resolution
  // rather than sending one: direct intake exists only for a source shape that
  // supports it — the engine DOWNGRADES a requested `direct` on any other
  // source to planned (warn-not-block), so a requested-but-unsupported direct
  // must still get the coordinator handoff prompt here or the plan gate the
  // engine mints would sit with nobody prompted to fill it.
  const runsDirect = sourcePlanKindSupportsDirectIntake(sourcePlanKind) && intake !== 'planned'

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
      ...(repos && repos.length > 0 ? { repos } : {}),
      ...(useWorktrees === true && baseStartPoint?.trim() ? { baseStartPoint: baseStartPoint.trim() } : {}),
      roleRuntimes: buildSprintEngineRoleRuntimes(roleModelOverrides, roleCliDefaults, roleReasoningOverrides),
      enabledRoles,
      // The run's phase list, present only when set.
      ...(defaultPhases !== undefined ? { defaultPhases } : {}),
      ...(initSourceSeed
        ? { source: initSourceSeed.source, sourceBundle: initSourceSeed.sourceBundle }
        : {}),
      // Only when the caller chose; absent leaves the default with the engine.
      ...(intake ? { intake } : {}),
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

  // A direct run has no planning session to start (MC-2128). The graph already
  // exists on the board, so handing the coordinator seat a "review the sources and
  // build the task graph" prompt would spend the exact ~200k-token planning pass
  // this mode exists to remove — and would spend it re-deriving a graph the engine
  // already minted. Workers claim from the queue without it.
  if (!runsDirect) {
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
  }

  return {
    workspaceId,
    sprintEngineContext,
    plannerAgentId: planner.id,
  }
}

export type LaunchPlanSourcedSprintResult =
  | { ok: true; teamName: string; result: PlanSourcedSprintEngineWorkspaceResult }
  | { ok: false; code: string; message: string }

// The one-step plan-sourced sprint launch composition shared by every non-wizard
// entry path — the tracker-proxy "Start sprint" button (startTrackerProxySprint)
// and the automations `sprint.create` chain (useAutomationRequests). It owns the
// two pieces those paths used to duplicate: the self-trigger-guarded team-name
// numbering (resolveChainedSprintTeamName) and the create + error mapping, behind
// one stable `sprint_*` error vocabulary — so the entry paths cannot drift apart
// on collision handling or failure codes (the shape that produced MC-1716). The
// caller supplies the per-launch creation args (roster, autoState, worktree
// options) through `buildArgs`, and owns any post-create bookkeeping such as the
// backlog execution link.
export async function launchPlanSourcedSprint(input: {
  rootPath: string
  baseTeamName: string
  // A chained sprint must not recreate the team directory it was triggered from;
  // omitted by launches with no such loop risk (the tracker-proxy button).
  refuseTeamSlug?: string
  stateExists: (statePath: string) => boolean | Promise<boolean>
  buildArgs: (teamName: string) => PlanSourcedSprintEngineWorkspaceArgs
}): Promise<LaunchPlanSourcedSprintResult> {
  const resolved = await resolveChainedSprintTeamName({
    baseTeamName: input.baseTeamName,
    refuseTeamSlug: input.refuseTeamSlug,
    buildContext: (name) => buildPlanSourcedSprintEngineWorkspaceContext(input.rootPath, name),
    stateExists: (statePath) => Promise.resolve(input.stateExists(statePath)),
  })
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }

  try {
    const result = await createPlanSourcedSprintEngineWorkspace(input.buildArgs(resolved.teamName))
    return { ok: true, teamName: resolved.teamName, result }
  } catch (error) {
    if (error instanceof PlanSourcedSprintEngineWorkspaceError) {
      return {
        ok: false,
        code: `sprint_${error.code.replace(/-/g, '_')}`,
        message: error.message === error.code ? `Sprint run creation failed: ${error.code}.` : error.message,
      }
    }
    return {
      ok: false,
      code: 'sprint_creation_failed',
      message: error instanceof Error ? error.message : 'Sprint run creation failed.',
    }
  }
}

export type StartTrackerProxySprintResult =
  | { ok: true; teamName: string; teamSlug: string; workspaceId: WorkspaceId }
  | { ok: false; code: string; message: string }

// The one-step "Start sprint" composition (mockup §2, plan §3.6 + D6): create a
// plan-sourced run from an already-materialized proxy item, then record the
// backlog execution link — the identical end-state to materializing and running
// a sprint in two steps, minus the wizard. It reuses the shared plan-sourced
// creation path and reference-mode seeding (the on-disk proxy file the caller
// just refreshed IS the canonical seed); it is NOT a bespoke sprint pipeline.
// The team name numbers up on a directory collision (a prior launch from the
// same issue) exactly the way the chained-sprint path does, rather than failing.
// Ports are injected so this stays unit-testable without window/IPC.
export async function startTrackerProxySprint(args: {
  rootPath: string
  baseTeamName: string
  goal: string
  sourceRelativePath: string
  sourceContent: string
  sourcePlanKind: SprintEngineSourcePlanKind
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  roleModelOverrides: SprintEngineRoleModelOverrides | null
  initialSpawnRoles: SprintEngineRoleId[] | null
  sprintEngineAutoState: Partial<SprintEngineAutoState>
  workspaceWindowId?: WorkspaceWindowId | null
  pathExists: (path: string) => boolean | Promise<boolean>
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  recordExecutionLink: (input: {
    workspaceRoot: string
    sourceRelativePath: string
    teamSlug: string
    statePath: string
  }) => Promise<void>
}): Promise<StartTrackerProxySprintResult> {
  const launch = await launchPlanSourcedSprint({
    rootPath: args.rootPath,
    baseTeamName: args.baseTeamName.trim() || 'Sprint',
    stateExists: args.pathExists,
    buildArgs: (teamName) => ({
      rootPath: args.rootPath,
      teamName,
      goal: args.goal,
      sourcePath: args.sourceRelativePath,
      sourceContent: args.sourceContent,
      sourcePlanKind: args.sourcePlanKind,
      roleCounts: args.roleCounts,
      roleCliDefaults: args.roleCliDefaults,
      roleModelOverrides: args.roleModelOverrides,
      initialSpawnRoles: args.initialSpawnRoles,
      sprintEngineAutoState: args.sprintEngineAutoState,
      workspaceWindowId: args.workspaceWindowId,
      // The proxy file (just refreshed) is the canonical seed, referenced in place.
      sourceReference: true,
      pathExists: args.pathExists,
      initializeSprintEngineState: args.initializeSprintEngineState,
    }),
  })
  if (!launch.ok) return { ok: false, code: launch.code, message: launch.message }
  const { result } = launch

  // Best-effort execution link: the run exists on disk regardless, so a failed
  // link write must never surface as a failed launch (fallback discipline).
  try {
    await args.recordExecutionLink({
      workspaceRoot: args.rootPath,
      sourceRelativePath: args.sourceRelativePath,
      teamSlug: result.sprintEngineContext.teamSlug,
      statePath: result.sprintEngineContext.statePath,
    })
  } catch {
    // Link is bookkeeping; the sprint is already created and running.
  }

  return { ok: true, teamName: launch.teamName, teamSlug: result.sprintEngineContext.teamSlug, workspaceId: result.workspaceId }
}
