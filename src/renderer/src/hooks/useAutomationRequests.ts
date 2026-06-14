import { useEffect } from 'react'
import { nanoid } from 'nanoid'
import type {
  AutomationRendererRequest,
  AutomationRendererResponse,
} from '../../../shared/automation'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { useWorkspaceStore } from '../store/workspaceStore'
import { pickRandomAgentName } from '../utils/agentNames'
import { addAgentTabTiled, getModel } from '../utils/modelRegistry'
import type { WorkspaceWindowId } from '../types/workspace'

// Renderer half of the app-automation surface: the main-process MCP server
// delegates mutations here so they run the exact store actions the UI uses
// (addWorkspace / updateAgent + addAgentTabTiled), which in turn dispatch
// workspace.created / agent_terminal.* through the workspace-sync bus like any
// user-initiated change. Only the primary window answers; every failure is an
// explicit coded response, never a silent drop.

const LAYOUT_MODEL_WAIT_MS = 5_000
const LAYOUT_MODEL_POLL_MS = 100

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
    default:
      return {
        ok: false,
        code: 'unsupported_request',
        message: `Unsupported automation request kind "${(request as { kind?: string }).kind ?? 'unknown'}".`,
      }
  }
}

function createWorkspace(
  request: Extract<AutomationRendererRequest, { kind: 'workspace.create' }>
): AutomationRendererResponse {
  const template = request.templateId
    ? LAYOUT_TEMPLATES.find((candidate) => candidate.id === request.templateId)
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
  })
  return { ok: true, workspaceId }
}

async function launchAgent(
  request: Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
): Promise<AutomationRendererResponse> {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) {
    return { ok: false, code: 'unknown_workspace', message: `Workspace "${request.workspaceId}" does not exist in the renderer registry.` }
  }
  if (workspace.mode !== 'standard') {
    return {
      ok: false,
      code: 'unsupported_workspace_mode',
      message: `Automation agent launch supports standard workspaces; "${workspace.id}" is a ${workspace.mode} workspace.`,
    }
  }
  const cli = request.cli?.trim() || store.appSettings.lastSelectedCli
  if (!cli) {
    return { ok: false, code: 'no_cli_selected', message: 'No CLI was requested and no last-selected CLI is configured.' }
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
  const agentId = `agent-${cli}-${nanoid(6)}`
  const state = useWorkspaceStore.getState()
  state.updateAgent(workspace.id, agentId, {
    name,
    cli,
    kind: 'general',
    specialistId: undefined,
    cliStartupPrompt: request.prompt,
    cliOnboardingPromptSent: false,
    cliHasLaunched: false,
    cliResumeAvailable: false,
  })
  addAgentTabTiled(workspace.id, agentId, name)
  return { ok: true, workspaceId: workspace.id, agentId }
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
