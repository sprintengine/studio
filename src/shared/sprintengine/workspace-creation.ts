/**
 * The plan-sourced Sprint Engine creation path, shared by the window and by main
 * (MC-2160).
 *
 * It used to reach the renderer store directly for its two mutations (add the
 * workspace, hand the coordinator seat its startup prompt). Those became the
 * injected `workspace` port below: the renderer wires it to the store
 * (`sprintengineWorkspaceCreationPorts.ts`), main wires it to the workspace
 * registry, and everything between — the run context, the engine init payload,
 * the intake resolution, the handoff prompt — is the identical code on both
 * sides. Everything else in here was already pure.
 */
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
} from '../../renderer/src/types/workspace'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineStateInitializeInput,
  SprintEngineStateInitializeSource,
  SprintEngineStateInitializeSourceBundleItem,
} from '../electron-api'
import { derivePlanSourcedGoal } from './tracker-seeding'
import { resolveChainedSprintTeamName } from './chained-team-name'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  createInitialSprintEngineState,
  sprintEngineCoordinatorSeatForRoleCounts,
  sprintEngineEnabledRoles,
} from './state'
import type { SprintEngineIntake } from './run-types'
import { sourcePlanKindSupportsDirectIntake } from './run-types'
import {
  backlogDependenciesPlannedFromFields,
  parseBacklogFrontmatter,
} from '../backlog/frontmatter'
import { buildPlanFileSprintEngineHandoffPrompt } from './handoff-prompt'
import { buildRunWorkspaceContext } from './run-workspace-creation'
import { deriveSprintEngineAutomationDesiredMode } from './automation-lifecycle'
import type { SprintEngineWorkspaceCreationPort } from './workspace-creation-port'

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
  // Per-task worktrees (MC-2136): every task gets its own checkout branched off
  // the run branch and merged back at publish, instead of the whole run sharing
  // one. Layered on useWorktrees — never sent without it.
  taskIsolation?: boolean
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
  // Where the composed run is registered and where the coordinator seat's
  // startup prompt is queued — the store in a window, the workspace registry in
  // main. Required: creation that registers nowhere produces a run on disk that
  // nothing is tracking.
  workspace: SprintEngineWorkspaceCreationPort
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
  taskIsolation,
  repos,
  baseStartPoint,
  sourceReference,
  intake,
  pathExists,
  initializeSprintEngineState,
  workspace,
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
  //
  // With no intake stated, the engine's DEFAULT for an epic now follows the
  // epic's own `dependenciesPlanned:` mark (MC-2137) — an epic whose ordering
  // was never declared finished plans first. Callers that omit `intake`
  // (orchestrators, automations) must resolve it the same way here, or a planned run
  // would open its plan gate with nobody prompted to fill it.
  const supportsDirect = sourcePlanKindSupportsDirectIntake(sourcePlanKind)
  const resolvedIntake: SprintEngineIntake =
    intake
    ?? (supportsDirect && backlogDependenciesPlannedFromFields(parseBacklogFrontmatter(sourceContent).fields)
      ? 'direct'
      : 'planned')
  const runsDirect = supportsDirect && resolvedIntake === 'direct'

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
      // Only when chosen: an absent field keeps a per-sprint run's init payload
      // exactly what it was before per-task isolation was reachable.
      ...(useWorktrees === true && taskIsolation === true ? { taskIsolation: true } : {}),
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

  const workspaceId = await workspace.addWorkspace({
    sprintEngineState,
    sprintEngineContext,
    folderPath: trimmedRoot,
    roleCliDefaults,
    roleModelOverrides,
    initialSpawnRoles,
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

    await workspace.setStartupPrompt({ workspaceId, agentId: planner.id, startupPrompt })
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
// entry path — the automations `sprint.create` chain (main's sprint-create-service). It owns the
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

