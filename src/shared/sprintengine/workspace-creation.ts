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
import { joinPath } from '../source-paths'
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
  // (Horizon, automations) must resolve it the same way here, or a planned run
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
// entry path — the tracker "Start sprint" button (startTrackerIssueSprint)
// and the automations `sprint.create` chain (main's sprint-create-service). It owns the
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
  // Runs after the team name is resolved and before creation, for a source that
  // has to be written into the run's own directory rather than read from the
  // repo. A tracker issue has no file to point at, and writing one into
  // `backlog/` is exactly what MC-2361 removed — so it lands under
  // `.multi-code/sprintengine/<slug>/`, which is gitignored. A failure here
  // fails the launch: a run whose source never landed would hand the architect
  // a dangling path.
  prepareSource?: (context: SprintEngineWorkspaceContext) => Promise<void>
  buildArgs: (teamName: string) => PlanSourcedSprintEngineWorkspaceArgs
}): Promise<LaunchPlanSourcedSprintResult> {
  const resolved = await resolveChainedSprintTeamName({
    baseTeamName: input.baseTeamName,
    refuseTeamSlug: input.refuseTeamSlug,
    buildContext: (name) => buildPlanSourcedSprintEngineWorkspaceContext(input.rootPath, name),
    stateExists: (statePath) => Promise.resolve(input.stateExists(statePath)),
  })
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }

  if (input.prepareSource) {
    try {
      await input.prepareSource(buildPlanSourcedSprintEngineWorkspaceContext(input.rootPath, resolved.teamName))
    } catch (error) {
      return {
        ok: false,
        code: 'sprint_source_write_failed',
        message: error instanceof Error ? error.message : 'Could not write the sprint source.',
      }
    }
  }

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

// The file a tracker-sourced run's seed is written into, inside the run's own
// directory. `.multi-code/sprintengine/*` is gitignored, so the issue text never
// reaches the repository — which is the entire point of MC-2361. The name
// matches the engine's own `handover_path_for_state`, so the architect's
// handover call finds it where the engine already expects a handover document.
export const TRACKER_ISSUE_SOURCE_FILENAME = 'handover.md'

// The sidecar recording which tracker issue a run was started from. Written
// beside the run state (also gitignored) so write-back can resolve a run's issue
// without a proxy backlog item to look it up through — the lookup MC-2359
// re-keys onto this.
export const TRACKER_RUN_SOURCE_FILENAME = 'tracker-source.json'

export type TrackerRunSourceRecord = {
  provider: string
  connectionId: string
  externalId: string
  nativeKey: string
  url: string
  capturedAt: string
}

export type StartTrackerProxySprintResult =
  | { ok: true; teamName: string; teamSlug: string; workspaceId: WorkspaceId }
  | { ok: false; code: string; message: string }

// The one-step "Start sprint from a tracker issue" composition (MC-2358).
//
// It used to require a file: the caller materialized the issue into `backlog/`,
// re-scanned, found the new item, and seeded a reference-mode run from it. That
// put another team's tickets into a git-tracked directory, and told the
// architect to edit a file the next refresh would overwrite.
//
// Now the issue never touches the repository. Its markdown is written into the
// run's own gitignored directory as the run's handover document, and the run is
// created in COPY mode — the architect hands the snapshot over to the engine,
// which takes it into the run store. Nothing tells the architect to update a
// canonical file, because there is no canonical file: the tracker is the system
// of record.
//
// Collision numbering and error mapping stay in `launchPlanSourcedSprint` so
// this path and the automations path cannot drift (the MC-1716 shape). Ports are
// injected so this is unit-testable without window/IPC.
export async function startTrackerIssueSprint(args: {
  rootPath: string
  baseTeamName: string
  goal: string
  // The composed issue markdown (see shared/tracker/issue-markdown.ts), already
  // fetched fresh by the caller. Written into the run directory, never the repo.
  sourceContent: string
  // Identity of the issue this run came from, recorded beside the run state so
  // write-back can find it with no backlog item in existence.
  issue: TrackerRunSourceRecord
  sourcePlanKind: SprintEngineSourcePlanKind
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: SprintEngineRoleCliDefaults
  roleModelOverrides: SprintEngineRoleModelOverrides | null
  initialSpawnRoles: SprintEngineRoleId[] | null
  sprintEngineAutoState: Partial<SprintEngineAutoState>
  workspaceWindowId?: WorkspaceWindowId | null
  pathExists: (path: string) => boolean | Promise<boolean>
  // Creates the run directory (recursively) before anything is written into it.
  // The run does not exist yet at this point — creation happens after — so
  // writing straight into it would fail with ENOENT.
  ensureDirectory: (path: string) => Promise<void>
  // Writes an absolute path. Bound to `window.api.writefile` in the renderer.
  writeFile: (path: string, content: string) => Promise<void>
  initializeSprintEngineState: (
    input: SprintEngineStateInitializeInput
  ) => Promise<SprintEngineArtifactCommandResult>
  workspace: SprintEngineWorkspaceCreationPort
}): Promise<StartTrackerProxySprintResult> {
  // Both writes land in the run's own directory, which the run context already
  // names. Using `teamDirectoryPath` + `joinPath` rather than slicing the state
  // path keeps this correct on Windows, where the separator is a backslash.
  const runFile = (context: SprintEngineWorkspaceContext, fileName: string): string =>
    joinPath(context.teamDirectoryPath, fileName)

  const launch = await launchPlanSourcedSprint({
    rootPath: args.rootPath,
    baseTeamName: args.baseTeamName.trim() || 'Sprint',
    stateExists: args.pathExists,
    // Write the snapshot and the issue reference before the run exists, so the
    // architect's prompt can never point at a file that is not there yet.
    prepareSource: async (context) => {
      await args.ensureDirectory(context.teamDirectoryPath)
      await args.writeFile(runFile(context, TRACKER_ISSUE_SOURCE_FILENAME), args.sourceContent)
      await args.writeFile(
        runFile(context, TRACKER_RUN_SOURCE_FILENAME),
        `${JSON.stringify(args.issue, null, 2)}\n`
      )
    },
    buildArgs: (teamName) => {
      const context = buildPlanSourcedSprintEngineWorkspaceContext(args.rootPath, teamName)
      return {
        rootPath: args.rootPath,
        teamName,
        goal: args.goal,
        sourcePath: runFile(context, TRACKER_ISSUE_SOURCE_FILENAME),
        sourceContent: args.sourceContent,
        sourcePlanKind: args.sourcePlanKind,
        roleCounts: args.roleCounts,
        roleCliDefaults: args.roleCliDefaults,
        roleModelOverrides: args.roleModelOverrides,
        initialSpawnRoles: args.initialSpawnRoles,
        sprintEngineAutoState: args.sprintEngineAutoState,
        workspaceWindowId: args.workspaceWindowId,
        // COPY, not reference. There is no canonical repo file to keep in step
        // with, so the architect must never be told to update one — the snapshot
        // is handed to the engine and the tracker stays the system of record.
        sourceReference: false,
        pathExists: args.pathExists,
        initializeSprintEngineState: args.initializeSprintEngineState,
        workspace: args.workspace,
      }
    },
  })
  if (!launch.ok) return { ok: false, code: launch.code, message: launch.message }
  const { result } = launch

  // No backlog execution link: there is no backlog item to link. The run's issue
  // reference lives in the sidecar written above, which is what write-back reads.
  return { ok: true, teamName: launch.teamName, teamSlug: result.sprintEngineContext.teamSlug, workspaceId: result.workspaceId }
}
