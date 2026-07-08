import { useEffect } from 'react'
import { nanoid } from 'nanoid'
import type {
  AutomationRendererRequest,
  AutomationRendererResponse,
} from '../../../shared/automation'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { useWorkspaceStore } from '../store/workspaceStore'
import { pickRandomAgentName } from '../utils/agentNames'
import { getModel, removeAgentTab, revealAgentTab, type AgentTabRevealTarget } from '../utils/modelRegistry'
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
  resolveInitialSprintEngineRoster,
} from '../components/workspace/newWorkspace/savedTeams'
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
  return revealAgentTab(target, {
    getWorkspace: (workspaceId) =>
      useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId) ?? null,
    setActiveWorkspace: (workspaceId) => useWorkspaceStore.getState().setActiveWorkspace(workspaceId),
    updateLayout: (workspaceId, layoutModel) => useWorkspaceStore.getState().updateLayout(workspaceId, layoutModel),
  })
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
// roster (last saved team, else the built-in default), run the new-team
// controller (main's one-shot Python init writes run.yaml), add the workspace,
// then activate it so the board panel mounts — the mount effect is what
// consumes initial spawns and launches the architect. Waiting for the layout
// model here is the renderer-side half of that start guarantee; main confirms
// the architect's live terminal session before reporting success.
async function createSprint(
  request: Extract<AutomationRendererRequest, { kind: 'sprint.create' }>
): Promise<AutomationRendererResponse> {
  const store = useWorkspaceStore.getState()
  const roleSettings = store.appSettings.sprintEngineRoleSettings
  const roster = resolveInitialSprintEngineRoster({
    savedTeams: roleSettings?.savedTeams ?? [],
    lastSelectedTeamId: roleSettings?.lastSelectedTeamId ?? null,
    savedRoster: roleSettings?.savedRoster ?? null,
    defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
    defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  })

  let args: OnCreateArgs
  try {
    args = await runSprintEngineNewTeamCreation(
      {
        folderPath: request.folderPath,
        teamName: request.name?.trim() ?? '',
        goal: request.goal,
        roleCounts: roster.roleCounts,
        visibleRoleCounts: roster.roleCounts,
        maxParallelAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
        roleCliDefaults: roster.roleCliDefaults,
        roleModelOverrides: roster.roleModelOverrides,
        // Only a non-manual run carries a start-at-launch intent; a manual run
        // deliberately sits idle until a person opens it.
        initialSpawnRoles: request.startRunner === true ? ['architect'] : null,
        startRunner: request.startRunner === true,
        autoApproveArtifacts: request.autoApproveArtifacts === true,
        useWorktrees: request.useWorktrees === true,
        // External creation never escalates CLI permissions.
        cliPermissionPreset: 'default',
        rosterSource: 'user',
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
  // (catalog → single-server MCP + driving skill); the resolved settings ride the
  // AgentState so the terminal launch writes the connector's .mcp.json into the
  // run worktree and installs its skill. An unavailable/non-connector id is an
  // explicit failure — never launch a plain agent that silently drops the
  // connector environment.
  const connector = request.connectorId ? await resolveConnectorLaunch(request.connectorId) : null
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
    cliPermissionPreset: request.permissionPreset,
    kind: specialistId ? 'specialist' : 'general',
    specialistId,
    // Route the agent's terminal cwd into the run's isolated worktree when the
    // executor created one; TerminalView reads execution.cwd at launch.
    ...(worktreePath
      ? { execution: { mode: 'worktree' as const, worktreeId: null, cwd: worktreePath } }
      : {}),
    // Carry the resolved connector environment onto the AgentState so TerminalView
    // launches with the connector's single-server MCP (written into the worktree
    // .mcp.json) and its driving skill — the connector-chat isolation invariant.
    ...(connector?.ok
      ? { connectorMcpSettings: connector.resolved.mcpSettings, connectorSkillId: connector.resolved.skillId }
      : {}),
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
