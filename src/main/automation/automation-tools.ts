import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { Workspace } from '../../renderer/src/types/workspace'
import type { McpToolRegistration, McpToolResult } from './mcp-socket-server'
import { createWorkspaceConfirmed } from '../workspace-create'

// The v1 automation tool surface: workspace.create / workspace.list /
// workspace.status / agent.launch / agent.status. Reads answer from main's
// authoritative stores and never touch the renderer. Mutations are delegated
// to the primary renderer (same store actions the UI runs) and are confirmed
// against the workspace-sync bus before success is reported.

// Workspaces persisted before this app session hydrate into the sync service
// from the routing snapshot as placeholders (real id + window membership,
// placeholder name/template). Read projections disclose that honestly.
const ROUTING_PLACEHOLDER_TEMPLATE_ID = 'workspace-sync-routing-placeholder'

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 150

export type AutomationBackends = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  listTerminalSessions(): TerminalSessionSnapshot[]
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createAutomationTools(backends: AutomationBackends): McpToolRegistration[] {
  const now = backends.now ?? Date.now
  const sleep = backends.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function waitFor<T>(timeoutMs: number, probe: () => T | null): Promise<T | null> {
    const deadline = now() + timeoutMs
    for (;;) {
      const found = probe()
      if (found !== null) return found
      if (now() >= deadline) return null
      await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
  }

  function findWorkspace(workspaceId: string): Workspace | null {
    return backends.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
  }

  function workspaceWindowId(workspaceId: string): string | null {
    const { workspaceWindows } = backends.getWorkspaceSyncSnapshot().state
    return workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))?.id ?? null
  }

  function agentTerminalSession(workspaceId: string, agentId: string, cliSessionId?: string): TerminalSessionSnapshot | null {
    return (
      backends.listTerminalSessions().find(
        (session) =>
          session.kind === 'agent'
          && session.workspaceId === workspaceId
          && (session.agentId === agentId || (cliSessionId !== undefined && session.sessionId === cliSessionId))
      ) ?? null
    )
  }

  function workspaceProjection(workspace: Workspace): Record<string, unknown> {
    return {
      id: workspace.id,
      name: workspace.name,
      mode: workspace.mode,
      folderPath: workspace.folderPath,
      windowId: workspaceWindowId(workspace.id),
      detail: workspace.templateId === ROUTING_PLACEHOLDER_TEMPLATE_ID ? 'routing-only' : 'full',
      agentIds: Object.keys(workspace.agents),
    }
  }

  function agentProjection(workspace: Workspace, agentId: string): Record<string, unknown> {
    const agent = workspace.agents[agentId]
    const session = agentTerminalSession(workspace.id, agentId, agent?.cliSessionId)
    return {
      workspaceId: workspace.id,
      agentId,
      name: agent?.name ?? null,
      cli: agent?.cli ?? null,
      cliStartRequested: agent?.cliStartRequested ?? false,
      cliHasLaunched: agent?.cliHasLaunched ?? false,
      cliSessionId: agent?.cliSessionId ?? null,
      terminal: session
        ? {
            sessionId: session.sessionId,
            processAlive: session.processAlive,
            startedAt: session.startedAt,
            lastOutputAt: session.lastOutputAt,
          }
        : null,
    }
  }

  const workspaceList: McpToolRegistration = {
    name: 'workspace.list',
    description:
      'List workspaces known to the running Multicode instance, with window assignment and agent ids. '
      + 'Workspaces from before this app session appear with detail "routing-only" (real id/window, placeholder name).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { state } = backends.getWorkspaceSyncSnapshot()
      return success({
        workspaces: state.workspaces.map(workspaceProjection),
        activeWorkspaceId: state.activeWorkspaceId,
        primaryWindowId: state.primaryWorkspaceWindowId,
      })
    },
  }

  const workspaceStatus: McpToolRegistration = {
    name: 'workspace.status',
    description: 'Read one workspace from the main process store, including its agents and their terminal liveness.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list or workspace.create.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const workspace = findWorkspace(workspaceId)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      return success({
        workspace: workspaceProjection(workspace),
        agents: Object.keys(workspace.agents).map((agentId) => agentProjection(workspace, agentId)),
      })
    },
  }

  const workspaceCreate: McpToolRegistration = {
    name: 'workspace.create',
    description:
      'Create a workspace through the same renderer creation flow the UI uses. '
      + 'Success is confirmed by observing the workspace.created event on the workspace-sync bus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace display name.' },
        folderPath: { type: 'string', description: 'Absolute folder to open in the workspace.' },
        templateId: { type: 'string', description: 'Layout template id; defaults to the standard template.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['name', 'folderPath', 'templateId'])
      if (invalid) return invalid
      const outcome = await createWorkspaceConfirmed(
        {
          name: optionalString(args.name),
          folderPath: optionalString(args.folderPath),
          templateId: optionalString(args.templateId),
        },
        {
          delegateToRenderer: (request) => backends.delegateToRenderer(request),
          getWorkspaceSyncSnapshot: () => backends.getWorkspaceSyncSnapshot(),
          now,
          sleep,
        }
      )
      if (!outcome.ok) return failure(outcome.code, outcome.message)
      return success({ workspace: workspaceProjection(outcome.workspace) })
    },
  }

  const agentLaunch: McpToolRegistration = {
    name: 'agent.launch',
    description:
      'Add an agent to a workspace and start its CLI through the same renderer flow the UI uses. '
      + 'Success is confirmed by the agent terminal session registering with the main process.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id.' },
        cli: { type: 'string', description: 'Agent CLI plugin id (for example "claude-code" or "codex"); defaults to the last selected CLI.' },
        name: { type: 'string', description: 'Agent display name.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'prompt'])
      if (invalid) return invalid
      if (!findWorkspace(workspaceId)) {
        return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      }
      const delegated = await backends.delegateToRenderer({
        kind: 'agent.launch',
        workspaceId,
        cli: optionalString(args.cli),
        name: optionalString(args.name),
        prompt: optionalString(args.prompt),
      })
      if (!delegated.ok) return failure(delegated.code, delegated.message)
      const agentId = delegated.agentId
      if (!agentId) return failure('renderer_protocol_error', 'The renderer accepted the launch but returned no agent id.')
      const confirmed = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
        const workspace = findWorkspace(workspaceId)
        if (!workspace) return null
        const agent = workspace.agents[agentId]
        const session = agentTerminalSession(workspaceId, agentId, agent?.cliSessionId)
        return session?.processAlive ? workspace : null
      })
      if (!confirmed) {
        return failure(
          'launch_confirmation_timeout',
          `Agent "${agentId}" was added to workspace "${workspaceId}" but no live terminal session registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms; treat the launch as unverified. Read agent.status for the current state.`
        )
      }
      return success({ agent: agentProjection(confirmed, agentId) })
    },
  }

  const agentStatus: McpToolRegistration = {
    name: 'agent.status',
    description:
      "Read one agent's launch state from the main process store plus its terminal session liveness from the terminal runtime.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id.' },
        agentId: { type: 'string', description: 'Agent id within the workspace.' },
      },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const agentId = requireString(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const workspace = findWorkspace(workspaceId)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      // An agent is reportable if the bus knows it OR a terminal session exists
      // for it (sessions can register before the launch-state event lands).
      if (!workspace.agents[agentId] && !agentTerminalSession(workspaceId, agentId)) {
        return failure('unknown_agent', `Agent "${agentId}" is not known in workspace "${workspaceId}".`)
      }
      return success({ agent: agentProjection(workspace, agentId) })
    },
  }

  return [workspaceCreate, workspaceList, workspaceStatus, agentLaunch, agentStatus]
}

function success(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function requireString(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure('invalid_arguments', `"${key}" must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function firstInvalidOptionalString(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      return failure('invalid_arguments', `"${key}" must be a string when provided.`)
    }
  }
  return null
}
