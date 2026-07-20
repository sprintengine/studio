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
  TrackerProviderId,
} from '../../../shared/electron-api'
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
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
    // A recorded role MUST carry a CLI. Sweep roles supplied by the role
    // registry (e.g. nuclear_reviewer, spec_reviewer) are absent from
    // DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, so DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS
    // (derived from its keys) has no baseline entry for them. A model-only pick
    // then reaches here with cli:null and persists into run.yaml `roleRuntimes`
    // as `{model, cli:null}`, which hard-fails spawnAutoRunCandidate — it has no
    // 'claude-code' fallback the way reconcileSprintEngineAgents does, so the
    // roster runner stalls the task (and, via the tick's early return on a failed
    // spawn, every sibling behind it) and spams the diagnostics log. Default the
    // CLI whenever an entry is recorded so a runnable role never ships without one.
    if (model || cli) roleRuntimes[role] = { model, cli: cli ?? 'claude-code' }
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
  repos,
  baseStartPoint,
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
      ...(repos && repos.length > 0 ? { repos } : {}),
      ...(useWorktrees === true && baseStartPoint?.trim() ? { baseStartPoint: baseStartPoint.trim() } : {}),
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

export function derivePlanSourcedGoal(sourceContent: string, sourcePath: string): string {
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

// ---------------------------------------------------------------------------
// Tracker proxy sprint seeding (MC-1639, plan §3.6)
//
// A proxy backlog item mirrors an external tracker issue. When a sprint is
// seeded from one, the architect must read the FRESH issue — its current body
// and comment thread. Backlog launches are REFERENCE-mode (sourceReference),
// meaning the architect reads the on-disk file in place (see
// buildPlanFileSprintEngineHandoffPrompt) rather than an embedded snapshot; so
// freshness is delivered by refreshing that file through the T6 materialize
// upsert at seed time, then referencing it — not by composing content in the
// renderer (which the reference-mode handoff never reads).
//
// These are the pure, node-testable pieces of that seam: read a proxy's external
// identity from frontmatter (to know what to refresh), and locate the on-disk
// proxy item a one-step materialize just wrote (to reference it). The imperative
// materialize + create + link glue lives in the Backlog panel and reuses the
// shared plan-sourced creation path (D6: compose existing seams, never a bespoke
// sprint-from-tracker pipeline). A native (non-proxy) item never reaches any of
// this, so its seeding stays byte-identical to today.
// ---------------------------------------------------------------------------

// The external identity a proxy item carries in its flat underscore frontmatter
// keys (plan §3.4). provider/connection/id are required to refresh; key/url are
// best-effort display fields.
export type ProxyTrackerIdentity = {
  provider: TrackerProviderId
  connectionId: string
  externalId: string
  nativeKey: string
  url: string
}

function isTrackerProviderId(value: string): value is TrackerProviderId {
  return value === 'github' || value === 'jira' || value === 'linear'
}

// Read a backlog item's proxy identity from its frontmatter. Returns null for a
// native (non-proxy) item, or a proxy whose external block was stripped — the
// caller then takes the byte-identical native seeding path. Underscore keys only
// (a dotted key does not round-trip the frontmatter charset, plan §3.4).
export function parseProxyTrackerIdentity(sourceContent: string): ProxyTrackerIdentity | null {
  const { fields } = parseBacklogFrontmatter(sourceContent)
  const provider = fields.external_provider?.trim()
  const connectionId = fields.external_connection?.trim()
  const externalId = fields.external_id?.trim()
  if (!provider || !connectionId || !externalId || !isTrackerProviderId(provider)) return null
  return {
    provider,
    connectionId,
    externalId,
    nativeKey: fields.external_key?.trim() || '',
    url: fields.external_url?.trim() || '',
  }
}

// Locate the proxy backlog item that mirrors a given issue, by matching its
// one issue-typed sidecar link (target.kind `<provider>.issue`, target.id the
// externalId) written by the T6 materializer. Used after a one-step materialize
// to resolve the freshly written item's on-disk path + content. Pure over a
// minimal item shape (returns the caller's own item type).
export function matchProxyItemByIssue<
  T extends {
    relativePath: string
    path: string
    sourceContent: string
    links: ReadonlyArray<{ type: string; target?: { kind?: string; id?: string } }>
  },
>(items: ReadonlyArray<T>, provider: TrackerProviderId, externalId: string): T | null {
  const wantedKind = `${provider}.issue`
  for (const item of items) {
    for (const link of item.links) {
      if (link.type !== 'issue') continue
      if (link.target?.kind === wantedKind && link.target?.id === externalId) return item
    }
  }
  return null
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
  const baseTeamName = args.baseTeamName.trim() || 'Sprint'
  let teamName = baseTeamName
  let context = buildPlanSourcedSprintEngineWorkspaceContext(args.rootPath, teamName)
  for (let suffix = 2; await args.pathExists(context.statePath); suffix += 1) {
    if (suffix > 100) {
      return { ok: false, code: 'team_name_exhausted', message: `Could not find a free run name for "${baseTeamName}".` }
    }
    teamName = `${baseTeamName} ${suffix}`
    context = buildPlanSourcedSprintEngineWorkspaceContext(args.rootPath, teamName)
  }

  let result: PlanSourcedSprintEngineWorkspaceResult
  try {
    result = await createPlanSourcedSprintEngineWorkspace({
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
    })
  } catch (error) {
    if (error instanceof PlanSourcedSprintEngineWorkspaceError) {
      return {
        ok: false,
        code: error.code,
        message: error.message === error.code ? `Sprint run creation failed: ${error.code}.` : error.message,
      }
    }
    return {
      ok: false,
      code: 'creation_failed',
      message: error instanceof Error ? error.message : 'Sprint run creation failed.',
    }
  }

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

  return { ok: true, teamName, teamSlug: result.sprintEngineContext.teamSlug, workspaceId: result.workspaceId }
}
