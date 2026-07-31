import { useEffect } from 'react'
import { nanoid } from 'nanoid'
import type {
  AutomationRendererRequest,
  AutomationRendererResponse,
} from '../../../shared/automation'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { useWorkspaceStore } from '../store/workspaceStore'
import { pickRandomAgentName } from '../utils/agentNames'
import { getModel, removeAgentTab, type AgentTabRevealTarget } from '../utils/modelRegistry'
import { revealAgentTerminalTab } from '../utils/agentTabReveal'
import { buildSpecialistDirectiveStartupPrompt, getSpecialistAction } from '../specialists/specialistActions'
import { isAutomationsHostWorkspace } from '../utils/workspaceVisibility'
import { resolveConnectorLaunch } from '../utils/connectorLaunch'
import {
  SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
  SprintEngineNewTeamCreationError,
  runSprintEngineNewTeamCreation,
} from '../components/workspace/newWorkspace/controllers/sprintEngineController'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  NO_ROLES_ROSTER_ID,
  findSavedSprintEngineRoster,
  isNoRolesRosterRef,
  resolveInitialSprintEngineRoster,
  sprintEngineLaunchRoleCounts,
} from '../components/workspace/newWorkspace/savedRosters'
import {
  inferSourcePlanKind,
  joinPath,
  planBasename,
  toTitleName,
  workspaceRelativePath,
} from '../components/workspace/newWorkspace/helpers'
import { launchPlanSourcedSprint } from '../utils/sprintengineWorkspaceCreation'
import { normalizeCliPermissionPreset } from '../store/slices/settingsSlice'
import { sprintEngineCoordinatorSeatForRoleCounts, sprintEngineRoleKey } from '../utils/sprintengine'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../utils/sprintengineAutomationLifecycle'
import type { OnCreateArgs } from '../components/workspace/newWorkspace/controllers/types'
import { createAutomationsTemplate } from '../modules/automations-workspace-types'
import { AUTOMATIONS_HOST_WORKSPACE_MODE, type SpecialistActionId, type WorkspaceWindowId } from '../types/workspace'

// Renderer half of the app-automation surface: the main-process MCP server
// delegates mutations here so they run the exact store actions the UI uses
// (addWorkspace / updateAgent + addAgentTabTiled), which in turn dispatch
// workspace.created / agent_terminal.* through the workspace-sync bus like any
// user-initiated change. Only the primary window answers; every failure is an
// explicit coded response, never a silent drop.

const LAYOUT_MODEL_WAIT_MS = 5_000
const LAYOUT_MODEL_POLL_MS = 100

export function revealAutomationAgent(target: AgentTabRevealTarget): boolean {
  return revealAgentTerminalTab(target)
}

export function useAutomationRequests(workspaceWindowId: WorkspaceWindowId): void {
  useEffect(() => {
    if (workspaceWindowId !== 'primary') return
    if (typeof window.api?.onAutomationRequest !== 'function') return
    return window.api.onAutomationRequest((requestId, request) => {
      void handleAutomationRequest(request)
        .catch((error): AutomationRendererResponse => ({
          ok: false,
          code: 'renderer_error',
          message: error instanceof Error ? error.message : 'Automation request failed in the renderer.',
        }))
        .then((response) => window.api.automationRespond(requestId, response))
        .catch(() => {
          // The response invoke itself failed; main's request timeout reports
          // the explicit failure to the automation client.
        })
    })
  }, [workspaceWindowId])
}

async function handleAutomationRequest(request: AutomationRendererRequest): Promise<AutomationRendererResponse> {
  switch (request.kind) {
    case 'workspace.create':
      return createWorkspace(request)
    case 'agent.launch':
      return launchAgent(request)
    case 'agent.dispose':
      return disposeAgent(request)
    case 'sprint.create':
      return createSprint(request)
    default:
      return {
        ok: false,
        code: 'unsupported_request',
        message: `Unsupported automation request kind "${(request as { kind?: string }).kind ?? 'unknown'}".`,
      }
  }
}

// Create + start a Sprint Engine run the way the wizard does: resolve the
// roster (last saved roster, else the built-in default), run the new-team
// controller (main's one-shot Python init writes run.yaml), add the workspace,
// then activate it so the board panel mounts — the mount effect is what
// consumes initial spawns and launches the architect. Waiting for the layout
// model here is the renderer-side half of that start guarantee; main confirms
// the architect's live terminal session before reporting success.
// Roster resolution for an externally-created run. Precedence: an explicit
// `roster` (role id -> count) wins outright; else a named saved roster
// (`rosterName`); else the wizard's own fallback (last selected, saved roster,
// built-in default).
//
// The explicit path must seed `roleCliDefaults` for EVERY role it staffs.
// `DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS` is derived from the built-in count
// map's keys, which omit registry roles like `spec_reviewer` and
// `nuclear_reviewer` — a role with no CLI resolves to no runtime and is silently
// skipped at spawn (the 2026-07-19 gap pinned in auto-run-cycle.test.ts).
type RosterResolution =
  | { ok: true; roster: ReturnType<typeof resolveInitialSprintEngineRoster> }
  | { ok: false; response: AutomationRendererResponse }

function resolveRequestedRoster(
  request: Extract<AutomationRendererRequest, { kind: 'sprint.create' }>
): RosterResolution {
  const store = useWorkspaceStore.getState()
  const roleSettings = store.appSettings.sprintEngineRoleSettings
  const savedRosters = roleSettings?.savedRosters ?? []

  const explicit = request.roster
  if (explicit && Object.keys(explicit).length > 0) {
    // Zero-based, NOT seeded from the default counts: absent means off (owner,
    // 2026-07-14). Seeding from `DEFAULT_SPRINT_ENGINE_ROLE_COUNTS` would carry
    // its architect:1 / developer:1 into a roster that never asked for them —
    // the same "a default team that overrides user config" bug the empty-counts
    // base exists to prevent. The full key set is kept so the map stays the
    // shape `Required<>` consumers expect.
    const roleCounts: Record<string, number> = Object.fromEntries(
      Object.keys(DEFAULT_SPRINT_ENGINE_ROLE_COUNTS).map((role) => [role, 0])
    )
    for (const [role, count] of Object.entries(explicit)) {
      const trimmed = role.trim()
      if (!trimmed) {
        return { ok: false, response: { ok: false, code: 'sprint_invalid_roster', message: 'Roster role ids must be non-empty.' } }
      }
      if (!Number.isInteger(count) || count < 0) {
        return {
          ok: false,
          response: { ok: false, code: 'sprint_invalid_roster', message: `Roster count for "${trimmed}" must be a non-negative integer.` },
        }
      }
      roleCounts[trimmed] = count
    }
    if (!Object.values(roleCounts).some((count) => count > 0)) {
      return { ok: false, response: { ok: false, code: 'sprint_invalid_roster', message: 'Roster must staff at least one role.' } }
    }
    const roleCliDefaults = { ...DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS } as Record<string, string>
    for (const role of Object.keys(roleCounts)) {
      if (!roleCliDefaults[role]) roleCliDefaults[role] = 'claude-code'
    }
    return {
      ok: true,
      roster: {
        selectedRosterId: null,
        // SEAM (MC-1876 x sprint.create): an EXPLICIT role map is the caller
        // naming exact roles, so it is 'roles' formation by definition and wins
        // over the No-roles default. Deliberate: a caller that went to the
        // trouble of listing roles must not have them replaced by a plain-agent
        // pool. To get No roles, send no roster at all.
        mode: 'roles',
        roleCounts,
        roleModelOverrides: {},
        roleCliDefaults,
      } as ReturnType<typeof resolveInitialSprintEngineRoster>,
    }
  }

  const requestedRosterName = request.rosterName?.trim()

  // The built-in resolves by name or id, and is never "not found".
  if (isNoRolesRosterRef(requestedRosterName)) {
    return {
      ok: true,
      roster: resolveInitialSprintEngineRoster({
        savedRosters,
        lastSelectedRosterId: null,
        savedRoster: null,
        defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
        defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
        explicitRosterRef: NO_ROLES_ROSTER_ID,
      }),
    }
  }

  // An unknown NAMED roster is an explicit failure — silently falling back
  // would staff the run with a roster the caller never picked. This branch is
  // deliberately unchanged by MC-1876: only an ABSENT roster gets the new
  // default; a named-but-missing one must still fail loudly.
  const namedRoster = findSavedSprintEngineRoster(savedRosters, requestedRosterName)
  if (requestedRosterName && !namedRoster) {
    return {
      ok: false,
      response: { ok: false, code: 'sprint_unknown_roster', message: `Saved roster "${requestedRosterName}" was not found.` },
    }
  }

  // MC-1876 — THE DEFAULT FLIP. An externally-created run (a Horizon step with
  // no `roster:`, an automation with no roster configured) used to resolve
  // through `lastSelectedRosterId`: whatever roster the user last touched in
  // the sprint WIZARD. A horizon running over days could therefore staff step 3
  // differently from step 1 because someone opened the wizard in between, and
  // nothing in the UI admitted it. Absent now means No roles — deterministic,
  // and independent of unrelated UI state.
  return {
    ok: true,
    roster: resolveInitialSprintEngineRoster({
      savedRosters,
      lastSelectedRosterId: null,
      savedRoster: null,
      defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
      defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
      explicitRosterRef: namedRoster?.id ?? NO_ROLES_ROSTER_ID,
    }),
  }
}

async function createSprint(
  request: Extract<AutomationRendererRequest, { kind: 'sprint.create' }>
): Promise<AutomationRendererResponse> {
  // A source-carrying request (sprint chaining) creates through the shared
  // plan-sourced path instead of the goal-sourced new-team controller.
  if (request.sourceRelativePath?.trim()) {
    return createPlanSourcedSprint(request, request.sourceRelativePath.trim())
  }
  const resolved = resolveRequestedRoster(request)
  if (!resolved.ok) return resolved.response
  const roster = resolved.roster
  // Formation decides staffing on THIS path too. Both sprint.create paths
  // resolve a roster through `resolveRequestedRoster`, so both must honor the
  // `mode` it returns — otherwise a "No roles" run created goal-sourced would
  // silently staff the specialist defaults and seat an architect, which is the
  // exact thing "no roles" excludes.
  const launchRoleCounts = sprintEngineLaunchRoleCounts(roster.mode, roster.roleCounts)

  let args: OnCreateArgs
  try {
    args = await runSprintEngineNewTeamCreation(
      {
        folderPath: request.folderPath,
        teamName: request.name?.trim() ?? '',
        goal: request.goal,
        roleCounts: launchRoleCounts,
        visibleRoleCounts: launchRoleCounts,
        maxParallelAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
        roleCliDefaults: roster.roleCliDefaults,
        roleModelOverrides: roster.roleModelOverrides,
        // Only a non-manual run carries a start-at-launch intent; a manual run
        // deliberately sits idle until a person opens it. The coordinator seat
        // follows the staffed counts rather than being hardcoded to `architect`:
        // a roles roster still resolves to the architect (byte-identical to
        // before), a no-roles roster to the roleless seat.
        initialSpawnRoles: request.startRunner === true
          ? [sprintEngineRoleKey(sprintEngineCoordinatorSeatForRoleCounts(launchRoleCounts).role)]
          : null,
        startRunner: request.startRunner === true,
        autoApproveArtifacts: request.autoApproveArtifacts === true,
        useWorktrees: request.useWorktrees === true,
        // External creation never escalates CLI permissions. This is the
        // GOAL-sourced path: an arbitrary caller with a bare goal and no
        // human-authored plan file behind it, so there is no consent to read.
        // Deliberately does NOT honor `request.permissionPreset` (MC-1900) —
        // otherwise the field would be exactly the self-escalation hole this
        // literal exists to close. A horizon always arrives plan-sourced.
        cliPermissionPreset: 'default',
      },
      {
        pathExists: window.api.pathExists,
        initializeSprintEngineState: window.api.initializeSprintEngineState,
      }
    )
  } catch (error) {
    if (error instanceof SprintEngineNewTeamCreationError) {
      return {
        ok: false,
        code: `sprint_${error.code.replace(/-/g, '_')}`,
        message: error.message === error.code
          ? `Sprint run creation failed: ${error.code}.`
          : error.message,
      }
    }
    throw error
  }

  const workspaceId = useWorkspaceStore.getState().addWorkspace(args.template, {
    name: args.name,
    folderPath: args.folderPath,
    windowId: 'primary',
    sprintEngineState: args.sprintEngineState,
    sprintEngineContext: args.sprintEngineContext,
    sprintEngineRoleCliDefaults: args.sprintEngineRoleCliDefaults,
    sprintEngineRoleModelOverrides: args.sprintEngineRoleModelOverrides,
    sprintEngineInitialSpawnRoles: args.sprintEngineInitialSpawnRoles,
    sprintEngineAutoState: args.sprintEngineAutoState,
  })
  const state = useWorkspaceStore.getState()
  if (state.activeWorkspaceId !== workspaceId) {
    state.setActiveWorkspace(workspaceId)
  }
  const model = await waitForLayoutModel(workspaceId)
  if (!model) {
    return {
      ok: false,
      code: 'workspace_layout_unavailable',
      message: `Sprint workspace "${workspaceId}" was created (run state is on disk) but its layout did not mount within ${LAYOUT_MODEL_WAIT_MS}ms, so the board could not start the run.`,
    }
  }
  return { ok: true, workspaceId }
}

// Sprint chaining (MC-1438): create + start a sprint from a backlog item (or any
// project-relative plan file) through the SAME plan-sourced creation path the
// wizard's "Start from backlog" uses — createPlanSourcedSprintEngineWorkspace →
// initializeSprintEngineState → addWorkspace — so the Backlog execution link and
// item lifecycle are preserved. No bespoke sprint bootstrapping.
async function createPlanSourcedSprint(
  request: Extract<AutomationRendererRequest, { kind: 'sprint.create' }>,
  sourceRelativePath: string
): Promise<AutomationRendererResponse> {
  const normalizedSourcePath = sourceRelativePath.replace(/\\/g, '/')
  if (/^(?:\/|[A-Za-z]:)/.test(normalizedSourcePath) || normalizedSourcePath.split('/').includes('..')) {
    return { ok: false, code: 'sprint_invalid_source', message: 'Sprint source must be a project-relative path.' }
  }

  const resolved = resolveRequestedRoster(request)
  if (!resolved.ok) return resolved.response
  const roster = resolved.roster
  // MC-1875: formation decides what actually staffs the run. A 'pool' ("no
  // roles") roster launches the plain-agent seed — one `general` planner, then
  // one agent minted per task up to the run's max-concurrency setting — NOT the
  // specialist counts it may still be carrying behind the wizard's disclosure.
  // Before this, Horizon could never start a pool run at all: it passed
  // roleCounts and nothing else, so formation was unexpressible.
  const launchRoleCounts = sprintEngineLaunchRoleCounts(roster.mode, roster.roleCounts)

  const absoluteSourcePath = joinPath(request.folderPath, normalizedSourcePath)
  if (!(await window.api.pathExists(absoluteSourcePath))) {
    return { ok: false, code: 'sprint_source_missing', message: `Sprint source "${normalizedSourcePath}" does not exist.` }
  }
  let sourceContent: string
  try {
    sourceContent = await window.api.readfile(absoluteSourcePath)
  } catch (error) {
    return {
      ok: false,
      code: 'sprint_source_unreadable',
      message: error instanceof Error ? error.message : `Sprint source "${normalizedSourcePath}" could not be read.`,
    }
  }

  // The derived name is deterministic (config sprint name, else the item's
  // basename), and a team dir with that slug may already exist — a prior wizard
  // launch from the same item, or an earlier fire of a recurring chain. A
  // collision must not hard-fail the chain (the trigger event is dedupe-marked,
  // so a failed fire never retries): the resolver refuses a self-trigger loop up
  // front, then numbers the team the way a user would until the slug is free.
  const baseTeamName = request.name?.trim() || toTitleName(planBasename(normalizedSourcePath))
  const startRunner = request.startRunner === true
  const automationMode = sprintEngineAutomationModeForRunOptions({
    startRunner,
    autoApproveArtifacts: request.autoApproveArtifacts === true,
  })
  const launch = await launchPlanSourcedSprint({
    rootPath: request.folderPath,
    baseTeamName,
    refuseTeamSlug: request.refuseTeamSlug,
    stateExists: window.api.pathExists,
    buildArgs: (teamName) => ({
      rootPath: request.folderPath,
      teamName,
      goal: request.goal,
      sourcePath: normalizedSourcePath,
      sourceContent,
      sourcePlanKind: inferSourcePlanKind(normalizedSourcePath, sourceContent),
      roleCounts: launchRoleCounts,
      roleCliDefaults: roster.roleCliDefaults,
      roleModelOverrides: roster.roleModelOverrides,
      // `sprintEngineCoordinatorSeatForRoleCounts` already answers the seat from
      // the counts, so pool mode needs no special case here once the counts are
      // right — pinned by a test rather than assumed.
      initialSpawnRoles: startRunner
        ? [sprintEngineRoleKey(sprintEngineCoordinatorSeatForRoleCounts(launchRoleCounts).role)]
        : null,
      sprintEngineAutoState: {
        ...sprintEngineAutomationInitialStateForMode(automationMode),
        // Plan-sourced launches are horizon/automation-orchestrated: nobody is
        // watching to answer per-tool prompts, so agents spawn in bypass unless
        // the horizon's own `permissions:` policy says otherwise (MC-1900). The
        // escalation is the OWNER'S file, not this caller — which is why the
        // goal-sourced twin below still refuses to read this field.
        //
        // Spawn-time only (MC-1808): this is the run's one chance to be bypass.
        cliPermissionPreset: normalizeCliPermissionPreset(request.permissionPreset ?? 'bypass_all'),
        maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
      },
      workspaceWindowId: 'primary',
      useWorktrees: request.useWorktrees === true,
      ...(request.baseStartPoint?.trim() ? { baseStartPoint: request.baseStartPoint.trim() } : {}),
      // Backlog/file sources are referenced in place, never copied.
      sourceReference: true,
      pathExists: window.api.pathExists,
      initializeSprintEngineState: window.api.initializeSprintEngineState,
    }),
  })
  if (!launch.ok) {
    return { ok: false, code: launch.code, message: launch.message }
  }
  const { result } = launch

  // Record the Backlog execution link so the item shows the running sprint and
  // its lifecycle flips to in_progress — the same link the wizard's backlog
  // launch writes. Best-effort: the run exists on disk either way.
  if (normalizedSourcePath.startsWith('backlog/')) {
    try {
      await window.api.addOrUpdateBacklogLink({
        workspaceRoot: request.folderPath,
        relativePath: normalizedSourcePath,
        link: {
          id: `sprint-engine:${result.sprintEngineContext.teamSlug}`,
          moduleId: 'sprint-engine',
          type: 'execution',
          label: 'Sprint',
          target: {
            kind: 'sprintengine.run',
            id: result.sprintEngineContext.teamSlug,
            path: workspaceRelativePath(request.folderPath, result.sprintEngineContext.statePath)
              ?? result.sprintEngineContext.statePath,
          },
          status: 'active',
        },
        status: 'in_progress',
      })
    } catch {
      // Link write is bookkeeping; never fail the launch for it.
    }
  }

  const state = useWorkspaceStore.getState()
  if (state.activeWorkspaceId !== result.workspaceId) {
    state.setActiveWorkspace(result.workspaceId)
  }
  const model = await waitForLayoutModel(result.workspaceId)
  if (!model) {
    return {
      ok: false,
      code: 'workspace_layout_unavailable',
      message: `Sprint workspace "${result.workspaceId}" was created (run state is on disk) but its layout did not mount within ${LAYOUT_MODEL_WAIT_MS}ms, so the board could not start the run.`,
    }
  }
  return { ok: true, workspaceId: result.workspaceId }
}

function createWorkspace(
  request: Extract<AutomationRendererRequest, { kind: 'workspace.create' }>
): AutomationRendererResponse {
  // A host workspace auto-created for a run gets the same single-surface control
  // template as a user-created Automations workspace, so the control center and
  // the run's deep-link target land on a real panel — never a bare standard
  // layout. An explicit templateId (legacy/MCP) still wins.
  const template = request.templateId
    ? LAYOUT_TEMPLATES.find((candidate) => candidate.id === request.templateId)
    : request.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
      ? createAutomationsTemplate()
      : LAYOUT_TEMPLATES[0]
  if (!template) {
    return {
      ok: false,
      code: 'unknown_template',
      message: `Layout template "${request.templateId ?? ''}" is not available. Known templates: ${LAYOUT_TEMPLATES.map((candidate) => candidate.id).join(', ')}.`,
    }
  }
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: request.name,
    folderPath: request.folderPath ?? null,
    windowId: 'primary',
    // An explicit mode (e.g. the automations executor's hidden 'automations-host'
    // host) wins over standard-derivation; omitted falls through to standard.
    // A mode-typed create may also REUSE an existing same-folder workspace of
    // that mode (automations-host, switchboard) instead of minting one.
    mode: request.mode,
    // Executor-triggered, not operator-triggered: creating (or reusing) the
    // hidden host must not close a door surface the operator is reading.
    background: true,
  })
  // Report the actual mode from the registry: main restores restart-survivor
  // workspaces as 'standard' routing placeholders, so a reused host's mode is
  // only knowable renderer-side. Callers assert against this, not the snapshot.
  const workspaceMode = useWorkspaceStore.getState().workspaces.find(
    (candidate) => candidate.id === workspaceId,
  )?.mode
  return { ok: true, workspaceId, ...(workspaceMode ? { workspaceMode } : {}) }
}

async function launchAgent(
  request: Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
): Promise<AutomationRendererResponse> {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) {
    return { ok: false, code: 'unknown_workspace', message: `Workspace "${request.workspaceId}" does not exist in the renderer registry.` }
  }
  // Agent-backed automation runs launch into either the per-project hidden
  // 'automations-host' workspace (the default route resolves-or-creates one) or a
  // standard workspace named by an explicit/legacy config workspaceId. Any other
  // mode is not a valid automation host.
  if (workspace.mode !== 'standard' && !isAutomationsHostWorkspace(workspace)) {
    return {
      ok: false,
      code: 'unsupported_workspace_mode',
      message: `Automation agent launch supports standard or automations-host workspaces; "${workspace.id}" is a ${workspace.mode} workspace.`,
    }
  }
  const cli = request.cli?.trim() || store.appSettings.lastSelectedCli
  if (!cli) {
    return { ok: false, code: 'no_cli_selected', message: 'No CLI was requested and no last-selected CLI is configured.' }
  }

  // A connector-backed automation run resolves the same way a connector chat does
  // (catalog or installed settings → single-server MCP, plus the driving skill
  // when the catalog pairs one); the resolved settings ride the AgentState so the
  // terminal launch writes the connector's .mcp.json into the run worktree. An
  // unavailable id is an explicit failure — never launch a plain agent that
  // silently drops the connector environment.
  const connector = request.connectorId
    ? await resolveConnectorLaunch(request.connectorId, store.appSettings.mcp?.servers)
    : null
  if (connector && !connector.ok) {
    return { ok: false, code: 'connector_unavailable', message: connector.message }
  }

  // Agent terminals render inside the active workspace's layout; activate the
  // target so its FlexLayout model mounts, then wait for it instead of
  // pretending the tab was added.
  if (store.activeWorkspaceId !== workspace.id) {
    store.setActiveWorkspace(workspace.id)
  }
  const model = await waitForLayoutModel(workspace.id)
  if (!model) {
    return {
      ok: false,
      code: 'workspace_layout_unavailable',
      message: `Workspace "${workspace.id}" did not mount a layout model within ${LAYOUT_MODEL_WAIT_MS}ms; the agent tab cannot be added.`,
    }
  }

  // Mirrors WorkspaceManager's addNewCliAgent: agent record first, then the
  // tiled agent tab; the mounted terminal launches the CLI and dispatches
  // agent_terminal.assign_session through the sync bus itself.
  const currentAgents = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)?.agents ?? {}
  const name = request.name?.trim() || pickRandomAgentName(Object.values(currentAgents).map((agent) => agent.name))
  // The picker constrains specialistId to the catalog; trust it at this boundary.
  const specialistId = (request.specialistId?.trim() || undefined) as SpecialistActionId | undefined
  // A specialist automation must fetch its Soul before acting, just like an
  // interactively-spawned specialist. The renderer owns the specialist→soul
  // mapping, so wrap the main-composed directive in the autonomous soul-fetch
  // preamble here; a non-specialist run sends the directive unchanged.
  const cliStartupPrompt = specialistId
    ? buildSpecialistDirectiveStartupPrompt(getSpecialistAction(specialistId), request.prompt ?? '')
    : request.prompt
  const agentId = `agent-${cli}-${nanoid(6)}`
  const state = useWorkspaceStore.getState()
  const worktreePath = request.worktreePath?.trim() || undefined
  state.updateAgent(workspace.id, agentId, {
    name,
    cli,
    // Persisted so relaunch/resume keep the model and permission the run was
    // created with (the terminal launch path reads them off AgentState).
    cliModel: request.cliModel?.trim() || undefined,
    // The automation path never arrives here unset: the spawn-agent action
    // resolves the preset for every start path (AUTOMATION_DEFAULT_PERMISSION_PRESET,
    // spawn-agent.ts), so an automation's answer is decided in one place and this
    // request carries it verbatim. The fallback covers the other agent.launch
    // callers, which take the app-level spawn default (MC-1900).
    cliPermissionPreset: request.permissionPreset ?? state.appSettings.lastAgentSpawnPermissionPreset,
    kind: specialistId ? 'specialist' : 'general',
    specialistId,
    // Route the agent's terminal cwd into the run's isolated worktree when the
    // executor created one; TerminalView reads execution.cwd at launch.
    ...(worktreePath
      ? { execution: { mode: 'worktree' as const, worktreeId: null, cwd: worktreePath } }
      : {}),
    // Carry the resolved connector environment onto the AgentState so TerminalView
    // launches with the connector's single-server MCP (written into the worktree
    // .mcp.json) plus its driving skill when the catalog pairs one — the
    // connector-chat isolation invariant.
    ...(connector?.ok
      ? {
          connectorMcpSettings: connector.resolved.mcpSettings,
          ...(connector.resolved.skillId ? { connectorSkillId: connector.resolved.skillId } : {}),
        }
      : {}),
    // A built-in skill attached to the automation (e.g. 'backlog'): the terminal
    // spawn installs it into the run's working directory before the CLI starts.
    // Independent of the connector's driving skill — both install at spawn.
    ...(request.spawnSkillId?.trim() ? { spawnSkillId: request.spawnSkillId.trim() } : {}),
    cliStartupPrompt,
    cliOnboardingPromptSent: false,
    cliHasLaunched: false,
    cliResumeAvailable: false,
  })
  if (!revealAutomationAgent({ workspaceId: workspace.id, agentId, name })) {
    return {
      ok: false,
      code: 'agent_tab_unavailable',
      message: `Agent "${agentId}" was created in workspace "${workspace.id}" but its terminal tab could not be revealed.`,
    }
  }
  return { ok: true, workspaceId: workspace.id, agentId }
}

// Remove a spawned automation agent entirely: kill its terminal, drop its
// layout tab, and delete the agent record. Called at run finalize so a one-shot
// automation agent never lingers pointing at a torn-down run worktree. Idempotent
// — an already-gone workspace/agent returns ok so a duplicate finalize is benign.
function disposeAgent(
  request: Extract<AutomationRendererRequest, { kind: 'agent.dispose' }>
): AutomationRendererResponse {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === request.workspaceId)
  const agent = workspace?.agents[request.agentId]
  // Kill the live terminal session (a finished agent has usually already exited;
  // best-effort either way), drop the tab, then delete the record. Order matters:
  // remove the record last so any tab-close handler still sees the agent.
  if (agent?.cliSessionId) void window.api.terminalKill(agent.cliSessionId).catch(() => {})
  removeAgentTab(request.workspaceId, request.agentId)
  store.removeAgent(request.workspaceId, request.agentId)
  return { ok: true, workspaceId: request.workspaceId, agentId: request.agentId }
}

async function waitForLayoutModel(workspaceId: string): Promise<ReturnType<typeof getModel>> {
  const deadline = Date.now() + LAYOUT_MODEL_WAIT_MS
  for (;;) {
    const model = getModel(workspaceId)
    if (model) return model
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, LAYOUT_MODEL_POLL_MS))
  }
}
