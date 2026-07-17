import { isAbsolute } from 'path'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { SprintEngineCliPermissionPreset, SprintEngineProjectionReadResult, TerminalSessionSnapshot } from '../../shared/electron-api'
import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import type { Workspace } from '../../renderer/src/types/workspace'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCreateEpicInput,
  BacklogCreateEpicResult,
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogEpicInput,
  BacklogItemStatusPayload,
  BacklogMutationResult,
  BacklogRiskPayload,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogTypePayload,
} from '../../shared/electron-api'
import type { BacklogCreateInput, BacklogCreateResult, BacklogListItemsResult, BacklogReadItemResult } from '../backlog-service'
import type { AutomationStoreListResult } from '../automations/store'
import type { AutomationsAppFrontDoor } from '../ipc/automations-ipc'
import { buildAgentBacklogLink } from '../../shared/backlog/agent-links'
import { isValidBacklogSlug } from '../../shared/backlog/frontmatter'
import type { McpToolRegistration, McpToolResult } from './mcp-socket-server'
import { createWorkspaceConfirmed } from '../workspace-create'

// The automation tool surface. v1: workspace.create / workspace.list /
// workspace.status / agent.launch / agent.status; the read expansion adds
// backlog.list / backlog.read / automation.list / automation.runs. Reads
// answer from main's authoritative stores and never touch the renderer.
// Mutations are delegated to the primary renderer (same store actions the UI
// runs) and are confirmed against the workspace-sync bus before success is
// reported.

// Workspaces persisted before this app session hydrate into the sync service
// from the routing snapshot as placeholders (real id + window membership,
// placeholder name/template). Read projections disclose that honestly.
const ROUTING_PLACEHOLDER_TEMPLATE_ID = 'workspace-sync-routing-placeholder'

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 150

// External callers get only these two presets; `bypass_all` is refused at the
// tool boundary everywhere (epic decision 4, same policy as automation.create).
const LAUNCH_PERMISSION_PRESETS = ['default', 'auto_workspace'] as const

export type AutomationBackends = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  listTerminalSessions(): TerminalSessionSnapshot[]
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  /** Read-only backlog listing for a workspace root (files + frontmatter, no writes). */
  listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>
  /** Read one backlog item (validated backlog/ relative path). */
  readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>
  /** Automation definitions from the workspace's .multi-code/automations store. */
  listAutomationDefinitions(workspaceRoot: string): Promise<AutomationStoreListResult<AutomationDefinition>>
  /** Run history for one automation, newest-first (store-capped). */
  listAutomationRuns(workspaceRoot: string, automationId: string): Promise<AutomationStoreListResult<AutomationRun>>
  /** Backlog write services (main-owned file/store writers in backlog-service). */
  backlogWrite: BacklogWriteBackends
  /**
   * The Automations module's IPC-equivalent create/run-now pipeline, resolved
   * lazily (the module kernel boots after the automation server's tools are
   * constructed). Null while the Automations module is disabled or not yet
   * loaded — tools report that explicitly instead of buffering.
   */
  getAutomationsFrontDoor(): AutomationsAppFrontDoor | null
  /** Absolute run.yaml paths under <root>/.multi-code/sprintengine, newest first. */
  listSprintRunStatePaths(workspaceRoot: string): Promise<string[]>
  /** One run's projection.json via the sprint-engine artifact reader (main-owned). */
  readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>
  /**
   * Create a git worktree for a widened agent.launch (model/preset/specialist
   * launches that request isolation, and every connector launch). Worktree
   * creation is renderer-adjacent but git-bound, so it happens in main before
   * delegating — the automations executor precedent. Returns the created
   * absolute path + branch, or `{ error }` (non-git folder, name collision,
   * git failure) which the tool surfaces as `worktree_unavailable`. Injected as
   * a backend so tests fake it.
   */
  createAgentWorktree(input: {
    workspaceRoot: string
    name: string
  }): Promise<{ worktreePath: string; branch: string } | { error: string }>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type BacklogWriteBackends = {
  createItem(input: BacklogCreateInput): Promise<BacklogCreateResult>
  createEpic(input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult>
  updateStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>
  updateType(input: BacklogTypeInput): Promise<BacklogMutationResult>
  updateTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>
  updateEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>
  addOrUpdateLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>
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

  // Backlog and Automations services speak absolute workspace roots; tools
  // speak workspace ids. Resolution goes through the sync snapshot, so a tool
  // can only ever reach folders belonging to workspaces open in the app.
  function resolveWorkspaceRoot(workspaceId: string): { root: string } | McpToolResult {
    const workspace = findWorkspace(workspaceId)
    if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    if (workspace.templateId === ROUTING_PLACEHOLDER_TEMPLATE_ID || !workspace.folderPath) {
      return failure(
        'workspace_without_folder',
        `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`
      )
    }
    return { root: workspace.folderPath }
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
      'Add a fully-configured agent to a workspace and start its CLI through the same renderer flow the UI uses. '
      + 'Optionally selects the model, permission preset, specialist, and connector, and isolates the agent in a '
      + 'git worktree. Success is confirmed by the agent terminal session registering with the main process.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id.' },
        cli: { type: 'string', description: 'Agent CLI plugin id (for example "claude-code" or "codex"); defaults to the last selected CLI.' },
        name: { type: 'string', description: 'Agent display name.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
        cliModel: { type: 'string', description: 'Model id for CLIs that support model selection; forwarded verbatim.' },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description: 'CLI permission preset. Only "default" or "auto_workspace"; "bypass_all" is refused on this surface.',
        },
        specialistId: { type: 'string', description: 'Launch as this specialist rather than a general agent; the renderer resolves it and fails if unknown.' },
        connectorId: {
          type: 'string',
          description:
            'Catalog connector id (e.g. "railway"). Attaches the connector\'s single-server MCP and driving skill and '
            + 'forces worktree isolation (the connector .mcp.json never lands in the checkout), even without "worktree".',
        },
        worktree: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' } },
          additionalProperties: false,
          description: 'Isolate the agent in a git worktree on an "agent/<name>" branch instead of the workspace checkout.',
        },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'prompt', 'cliModel', 'specialistId', 'connectorId'])
      if (invalid) return invalid

      // Permission preset: `bypass_all` is a distinct refusal (epic decision 4),
      // not a generic vocabulary error; any other non-allowed value is invalid.
      if (args.permissionPreset !== undefined) {
        if (typeof args.permissionPreset !== 'string') {
          return failure('invalid_arguments', '"permissionPreset" must be a string when provided.')
        }
        if (args.permissionPreset === 'bypass_all') {
          return failure(
            'permission_preset_not_allowed',
            'Agents launched over the automation surface may not use permissionPreset "bypass_all". '
              + 'A person can set that preset in the app if it is genuinely needed.'
          )
        }
        if (!LAUNCH_PERMISSION_PRESETS.includes(args.permissionPreset as (typeof LAUNCH_PERMISSION_PRESETS)[number])) {
          return failure('invalid_arguments', `"permissionPreset" must be one of: ${LAUNCH_PERMISSION_PRESETS.join(', ')}.`)
        }
      }

      // `worktree` is an object with an optional name — never a bare string or
      // an arbitrary cwd; a raw path is not an acceptable external surface.
      let worktreeRequested = false
      let worktreeName: string | undefined
      if (args.worktree !== undefined) {
        if (typeof args.worktree !== 'object' || args.worktree === null || Array.isArray(args.worktree)) {
          return failure('invalid_arguments', '"worktree" must be an object with an optional "name".')
        }
        const rawName = (args.worktree as { name?: unknown }).name
        if (rawName !== undefined && typeof rawName !== 'string') {
          return failure('invalid_arguments', '"worktree.name" must be a string when provided.')
        }
        worktreeRequested = true
        worktreeName = optionalString(rawName)
      }

      if (!findWorkspace(workspaceId)) {
        return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      }

      const connectorId = optionalString(args.connectorId)
      const permissionPreset = optionalString(args.permissionPreset) as SprintEngineCliPermissionPreset | undefined

      // A connector launch forces a worktree even when none was requested — the
      // connector .mcp.json must never land in the user's checkout (the
      // executor's connector-isolation invariant, epic point 3). Worktree
      // creation runs in main before delegating, and a failure here is fatal:
      // the caller asked for isolation, so we never silently fall back.
      let worktreePath: string | undefined
      if (worktreeRequested || connectorId) {
        const resolved = resolveWorkspaceRoot(workspaceId)
        if (!('root' in resolved)) return resolved
        const derivedName =
          worktreeName || optionalString(args.name) || connectorId || `agent-${now().toString(36)}`
        const created = await backends.createAgentWorktree({ workspaceRoot: resolved.root, name: derivedName })
        if ('error' in created) {
          return failure(
            'worktree_unavailable',
            `Could not create an isolated worktree for the launch (${created.error}). The folder must be a git repository.`
          )
        }
        worktreePath = created.worktreePath
      }

      const delegated = await backends.delegateToRenderer({
        kind: 'agent.launch',
        workspaceId,
        cli: optionalString(args.cli),
        name: optionalString(args.name),
        prompt: optionalString(args.prompt),
        cliModel: optionalString(args.cliModel),
        permissionPreset,
        specialistId: optionalString(args.specialistId),
        connectorId,
        worktreePath,
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
      return success({ agent: agentProjection(confirmed, agentId), ...(worktreePath ? { worktreePath } : {}) })
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

  const backlogList: McpToolRegistration = {
    name: 'backlog.list',
    description:
      'List the Backlog items and epics of a workspace (title, display id, status, type, triage axes, epic '
      + 'membership). Reads item files and frontmatter only — never writes. Archived items are omitted.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const listed = await backends.listBacklogItems(resolved.root)
      if (!listed.ok) return failure('backlog_unavailable', listed.message)
      return success({ workspaceKey: listed.key, items: listed.items })
    },
  }

  const backlogRead: McpToolRegistration = {
    name: 'backlog.read',
    description:
      'Read one Backlog item: parsed frontmatter fields plus the markdown body. '
      + 'The path must be a workspace-relative markdown path under backlog/.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        path: { type: 'string', description: 'Item path relative to the workspace root, e.g. "backlog/example.md".' },
      },
      required: ['workspaceId', 'path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const read = await backends.readBacklogItem(resolved.root, path)
      if (!read.ok) return failure('backlog_read_failed', read.message)
      return success({ item: read.item, body: read.body })
    },
  }

  const automationList: McpToolRegistration = {
    name: 'automation.list',
    description:
      "List a workspace's Automations (the outbound trigger/action definitions in .multi-code/automations). Read-only.",
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const listed = await backends.listAutomationDefinitions(resolved.root)
      if (!listed.ok) {
        return failure('automations_unavailable', listed.errors.map((problem) => problem.message).join('; '))
      }
      return success({ automations: listed.values })
    },
  }

  const automationRuns: McpToolRegistration = {
    name: 'automation.runs',
    description:
      "One automation's run history, newest first (the store keeps the most recent 50). Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        automationId: { type: 'string', description: 'Automation id from automation.list.' },
      },
      required: ['workspaceId', 'automationId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const automationId = requireString(args, 'automationId')
      if (typeof automationId !== 'string') return automationId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const listed = await backends.listAutomationRuns(resolved.root, automationId)
      if (!listed.ok) {
        return failure('automations_unavailable', listed.errors.map((problem) => problem.message).join('; '))
      }
      return success({ runs: listed.values })
    },
  }

  const BACKLOG_TYPES = ['epic', 'feature', 'bug', 'mockup', 'spike'] as const
  const BACKLOG_STATUSES = ['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'] as const
  const BACKLOG_DIFFICULTIES = ['xs', 's', 'm', 'l', 'xl'] as const
  const BACKLOG_CRITICALITIES = ['low', 'normal', 'high', 'critical'] as const
  const BACKLOG_RISKS = ['low', 'normal', 'high'] as const

  const backlogCreate: McpToolRegistration = {
    name: 'backlog.create',
    description:
      'Create a Backlog item — or an epic when type is "epic" (epics are grouping files under backlog/epics/). '
      + 'The item file is written with its lifecycle and triage in frontmatter; new items start as status "idea".',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        title: { type: 'string', description: 'Item title (first heading; also drives the filename slug).' },
        description: { type: 'string', description: 'Markdown body under the title heading. Ignored for epics.' },
        type: { type: 'string', enum: [...BACKLOG_TYPES], description: 'Item type; "epic" creates an epic file instead.' },
        difficulty: { type: 'string', enum: [...BACKLOG_DIFFICULTIES] },
        criticality: { type: 'string', enum: [...BACKLOG_CRITICALITIES] },
        risk: { type: 'string', enum: [...BACKLOG_RISKS] },
        epic: { type: 'string', description: 'Epic slug this item belongs to (not valid when creating an epic).' },
      },
      required: ['workspaceId', 'title'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const title = requireString(args, 'title')
      if (typeof title !== 'string') return title
      const invalid = firstInvalidOptionalString(args, ['description', 'type', 'difficulty', 'criticality', 'risk', 'epic'])
      if (invalid) return invalid
      const vocabulary = firstInvalidVocabulary(args, [
        ['type', BACKLOG_TYPES],
        ['difficulty', BACKLOG_DIFFICULTIES],
        ['criticality', BACKLOG_CRITICALITIES],
        ['risk', BACKLOG_RISKS],
      ])
      if (vocabulary) return vocabulary
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved

      if (args.epic !== undefined && !isValidBacklogSlug(args.epic)) {
        return failure('invalid_arguments', '"epic" must be a valid epic slug (letters, digits, dot, underscore, hyphen).')
      }
      if (optionalString(args.type) === 'epic') {
        if (args.epic !== undefined || args.difficulty !== undefined || args.criticality !== undefined || args.risk !== undefined) {
          return failure('invalid_arguments', 'Epics are grouping files and take no epic/difficulty/criticality/risk fields.')
        }
        const created = await backends.backlogWrite.createEpic({ workspaceRoot: resolved.root, title })
        if (!created.ok) return failure('backlog_create_failed', created.message)
        return success({ epic: { slug: created.slug, relativePath: created.relativePath } })
      }

      const created = await backends.backlogWrite.createItem({
        workspaceRoot: resolved.root,
        title,
        description: optionalString(args.description),
        type: optionalString(args.type),
        difficulty: optionalString(args.difficulty),
        criticality: optionalString(args.criticality),
        risk: optionalString(args.risk),
        epic: optionalString(args.epic),
      })
      if (!created.ok) return failure('backlog_create_failed', created.message)
      return success({ item: { relativePath: created.relativePath } })
    },
  }

  const backlogUpdate: McpToolRegistration = {
    name: 'backlog.update',
    description:
      "Update one Backlog item's lifecycle or triage frontmatter: status, type, difficulty, criticality, risk, "
      + 'or epic membership. Pass null to clear a field (status cannot be cleared). Only supplied fields change; '
      + 'the item body is never touched. Fields apply in a fixed order (status, type, triage, epic) and the first '
      + 'invalid field stops the write — fields earlier in the order stay applied.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        path: { type: 'string', description: 'Item path relative to the workspace root, e.g. "backlog/example.md".' },
        status: { type: 'string', enum: [...BACKLOG_STATUSES] },
        type: { type: ['string', 'null'], enum: [...BACKLOG_TYPES, null] },
        difficulty: { type: ['string', 'null'], enum: [...BACKLOG_DIFFICULTIES, null] },
        criticality: { type: ['string', 'null'], enum: [...BACKLOG_CRITICALITIES, null] },
        risk: { type: ['string', 'null'], enum: [...BACKLOG_RISKS, null] },
        epic: { type: ['string', 'null'], description: 'Epic slug, or null to remove the item from its epic.' },
      },
      required: ['workspaceId', 'path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const fields = ['status', 'type', 'difficulty', 'criticality', 'risk', 'epic'] as const
      if (!fields.some((field) => field in args)) {
        return failure('invalid_arguments', 'Supply at least one field to update.')
      }
      for (const field of fields) {
        if (field in args && args[field] !== null && typeof args[field] !== 'string') {
          return failure('invalid_arguments', `"${field}" must be a string${field === 'status' ? '' : ' or null'}.`)
        }
      }
      if (args.status === null) return failure('invalid_arguments', 'Status cannot be cleared, only changed.')
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved

      // Apply in a fixed order, stopping at the first failure; the services
      // validate vocabulary and report plain messages.
      // Values are passed through as-typed; the services own vocabulary
      // validation and return plain messages for anything invalid.
      const base = { workspaceRoot: resolved.root, relativePath: path }
      const writes: Array<() => Promise<BacklogMutationResult>> = []
      if (typeof args.status === 'string') {
        writes.push(() => backends.backlogWrite.updateStatus({ ...base, status: args.status as BacklogItemStatusPayload }))
      }
      if ('type' in args) {
        writes.push(() =>
          backends.backlogWrite.updateType({ ...base, type: (args.type ?? null) as BacklogTypePayload | null })
        )
      }
      if ('difficulty' in args || 'criticality' in args || 'risk' in args) {
        writes.push(() =>
          backends.backlogWrite.updateTriage({
            ...base,
            ...('difficulty' in args
              ? { difficulty: (args.difficulty ?? null) as BacklogDifficultyPayload | null }
              : {}),
            ...('criticality' in args
              ? { criticality: (args.criticality ?? null) as BacklogCriticalityPayload | null }
              : {}),
            ...('risk' in args ? { risk: (args.risk ?? null) as BacklogRiskPayload | null } : {}),
          })
        )
      }
      if ('epic' in args) {
        writes.push(() => backends.backlogWrite.updateEpic({ ...base, epic: (args.epic ?? null) as string | null }))
      }
      for (const write of writes) {
        const written = await write()
        if (!written.ok) return failure('backlog_update_failed', written.message)
      }
      return success({ updated: { relativePath: path } })
    },
  }

  const backlogAssign: McpToolRegistration = {
    name: 'backlog.assign',
    description:
      'Record which agent is working a Backlog item (the working-agent link shown in the Backlog panel). '
      + 'Idempotent — assigning again replaces the previous agent link. Never changes item status. '
      + "The panel's file watcher observes backlog/ item files, so a bare assignment appears on the panel's "
      + 'next refresh rather than instantly.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        path: { type: 'string', description: 'Item path relative to the workspace root, e.g. "backlog/example.md".' },
        agentId: { type: 'string', description: 'Agent id within the workspace (see workspace.status).' },
      },
      required: ['workspaceId', 'path', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const agentId = requireString(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const workspace = findWorkspace(workspaceId)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      const agent = workspace.agents[agentId]
      if (!agent) return failure('unknown_agent', `Agent "${agentId}" is not known in workspace "${workspaceId}".`)
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved

      const link = buildAgentBacklogLink({ workspaceId, agentId, agentName: agent.name || agentId })
      const written = await backends.backlogWrite.addOrUpdateLink({
        workspaceRoot: resolved.root,
        relativePath: path,
        link,
      })
      if (!written.ok) return failure('backlog_assign_failed', written.message)
      return success({ assigned: { relativePath: path, agentId, label: link.label } })
    },
  }

  function automationsFrontDoorOrFailure(): AutomationsAppFrontDoor | McpToolResult {
    const frontDoor = backends.getAutomationsFrontDoor()
    if (!frontDoor) {
      return failure(
        'automations_module_unavailable',
        'The Automations module is disabled or not loaded in this app session; enable it in Settings → Modules.'
      )
    }
    return frontDoor
  }

  const automationCreate: McpToolRegistration = {
    name: 'automation.create',
    description:
      'Create an Automation definition through the same validated pipeline the UI uses (provider/permission '
      + 'checks, schedule validation, workspace-root trust). The definition object carries name, trigger '
      + '{kind, config}, action {kind, config}, and optional status/autonomyDefault. Agent-backed actions with '
      + 'permissionPreset "bypass_all" are refused on this surface — that preset can only be set by a person in '
      + 'the app.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        definition: {
          type: 'object',
          description:
            'Automation definition draft: { name, trigger: { kind, config }, action: { kind, config }, '
            + 'status?, autonomyDefault? }. See automation.list output for the shape of existing definitions.',
        },
      },
      required: ['workspaceId', 'definition'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      if (typeof args.definition !== 'object' || args.definition === null || Array.isArray(args.definition)) {
        return failure('invalid_arguments', '"definition" must be an object.')
      }
      const preset = actionPermissionPreset(args.definition)
      if (preset === 'bypass_all') {
        return failure(
          'permission_preset_not_allowed',
          'Automations created over the automation surface may not use permissionPreset "bypass_all". '
            + 'A person can set that preset in the Automations panel if it is genuinely needed.'
        )
      }
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const frontDoor = automationsFrontDoorOrFailure()
      if (!('createDefinition' in frontDoor)) return frontDoor
      const created = await frontDoor.createDefinition({ workspaceRoot: resolved.root, definition: args.definition })
      if (!created.ok) return failure(created.code || 'automation_create_failed', created.message)
      return success({ automation: created.value })
    },
  }

  const automationRun: McpToolRegistration = {
    name: 'automation.run',
    description:
      'Run an existing schedule-triggered Automation now (the same "Run now" the panel offers). The run record '
      + 'is confirmed in the store before success. Agent-backed actions launch through the primary app window, '
      + 'so they fail with no_primary_window when no window is open.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        automationId: { type: 'string', description: 'Automation id from automation.list.' },
      },
      required: ['workspaceId', 'automationId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const automationId = requireString(args, 'automationId')
      if (typeof automationId !== 'string') return automationId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const frontDoor = automationsFrontDoorOrFailure()
      if (!('runNow' in frontDoor)) return frontDoor
      const ran = await frontDoor.runNow({ workspaceRoot: resolved.root, automationId })
      if (!ran.ok) return failure(ran.code || 'automation_run_failed', ran.message)
      return success({ definition: ran.value.definition, run: ran.value.run })
    },
  }

  const SPRINT_SLUG_RE = /^[A-Za-z0-9._-]+$/

  function sprintStatePath(root: string, slug: string): string {
    return [root, '.multi-code', 'sprintengine', slug, 'run.yaml'].join('/')
  }

  const sprintList: McpToolRegistration = {
    name: 'sprint.list',
    description:
      "List a workspace's Sprint Engine runs from their on-disk state (newest first). Read-only; each entry's "
      + 'slug feeds sprint.status.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const statePaths = await backends.listSprintRunStatePaths(resolved.root)
      return success({
        runs: statePaths.map((statePath) => {
          const segments = statePath.split(/[\\/]/)
          // Disclose the state file as a project-relative path, matching the
          // backlog tools; the absolute form is machine-specific noise.
          const relative = statePath.startsWith(resolved.root)
            ? statePath.slice(resolved.root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
            : statePath
          return { slug: segments[segments.length - 2] ?? '', statePath: relative }
        }),
      })
    },
  }

  const sprintStatus: McpToolRegistration = {
    name: 'sprint.status',
    description:
      "One Sprint Engine run's current projection (goal, tasks, artifacts, roster, completion) read from disk. "
      + 'The auto-runner mode (manual/running/paused) lives only in the renderer and is NOT part of this '
      + 'projection — do not infer it from this result.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
      },
      required: ['workspaceId', 'slug'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const slug = requireString(args, 'slug')
      if (typeof slug !== 'string') return slug
      if (!SPRINT_SLUG_RE.test(slug) || slug === '.' || slug === '..') {
        return failure('invalid_arguments', '"slug" must be a plain run slug from sprint.list.')
      }
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved
      const projection = await backends.readSprintEngineProjection(sprintStatePath(resolved.root, slug))
      if (!projection.ok) return failure('sprint_status_failed', projection.message)
      return success({ slug, projection: projection.data, changeToken: projection.token ?? null })
    },
  }

  const sprintCreate: McpToolRegistration = {
    name: 'sprint.create',
    description:
      'Create a Sprint Engine run in a new workspace, through the same creation path the app wizard uses '
      + '(roster defaults to the last saved team, else the built-in team; CLI permissions stay at "default"). '
      + 'With startRunner the architect is launched and success is confirmed by its live terminal session; '
      + 'without it the run is created in manual mode and sits idle until a person opens it. Requires an open '
      + 'primary app window.',
    inputSchema: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Absolute project folder for the run workspace.' },
        goal: { type: 'string', description: 'The sprint goal the architect plans against.' },
        name: { type: 'string', description: 'Team/run display name.' },
        startRunner: { type: 'boolean', description: 'Start the auto-runner (launches the architect). Default false.' },
        autoApproveArtifacts: { type: 'boolean', description: 'Auto-approve run artifacts (only with startRunner).' },
        useWorktrees: { type: 'boolean', description: 'Isolate task work in per-task git worktrees.' },
      },
      required: ['folderPath', 'goal'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const folderPath = requireString(args, 'folderPath')
      if (typeof folderPath !== 'string') return folderPath
      if (!isAbsolute(folderPath)) {
        return failure('invalid_arguments', '"folderPath" must be an absolute path.')
      }
      const goal = requireString(args, 'goal')
      if (typeof goal !== 'string') return goal
      const invalid = firstInvalidOptionalString(args, ['name'])
      if (invalid) return invalid
      for (const key of ['startRunner', 'autoApproveArtifacts', 'useWorktrees']) {
        if (args[key] !== undefined && typeof args[key] !== 'boolean') {
          return failure('invalid_arguments', `"${key}" must be a boolean when provided.`)
        }
      }
      const startRunner = args.startRunner === true

      const delegated = await backends.delegateToRenderer({
        kind: 'sprint.create',
        folderPath,
        goal,
        name: optionalString(args.name),
        startRunner,
        autoApproveArtifacts: args.autoApproveArtifacts === true,
        useWorktrees: args.useWorktrees === true,
      })
      if (!delegated.ok) return failure(delegated.code, delegated.message)
      const workspaceId = delegated.workspaceId

      // Bus confirmation first (the workspace itself), then — only for a
      // started run — the architect's live terminal session, the same proof
      // agent.launch uses. A manual run has deliberately launched nothing.
      const workspace = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => findWorkspace(workspaceId))
      if (!workspace) {
        return failure(
          'creation_confirmation_timeout',
          `The renderer created sprint workspace "${workspaceId}" but it did not appear on the workspace-sync bus within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms; treat the creation as unverified and read workspace.status.`
        )
      }
      if (startRunner) {
        const architectLive = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
          const session = backends
            .listTerminalSessions()
            .find(
              (candidate) =>
                candidate.kind === 'agent' && candidate.workspaceId === workspaceId && candidate.processAlive
            )
          return session ?? null
        })
        if (!architectLive) {
          return failure(
            'launch_confirmation_timeout',
            `Sprint run and workspace "${workspaceId}" were created, but no live agent terminal registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms — the architect start is unverified. Read sprint.status and workspace.status for the current state.`
          )
        }
      }
      return success({ workspaceId, started: startRunner })
    },
  }

  return [
    workspaceCreate,
    workspaceList,
    workspaceStatus,
    agentLaunch,
    agentStatus,
    backlogList,
    backlogRead,
    backlogCreate,
    backlogUpdate,
    backlogAssign,
    automationList,
    automationRuns,
    automationCreate,
    automationRun,
    sprintList,
    sprintStatus,
    sprintCreate,
  ]
}

// The definition draft's action config is opaque at this layer; the preset key
// is the one security-relevant field the tool inspects before handing the
// draft to the validated pipeline.
function actionPermissionPreset(definition: object): string | null {
  const action = (definition as { action?: unknown }).action
  if (typeof action !== 'object' || action === null) return null
  const config = (action as { config?: unknown }).config
  if (typeof config !== 'object' || config === null) return null
  const preset = (config as { permissionPreset?: unknown }).permissionPreset
  return typeof preset === 'string' ? preset : null
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

// The socket server passes tool arguments through unvalidated (inputSchema is
// documentation for clients), so vocabulary enums are enforced here.
function firstInvalidVocabulary(
  args: Record<string, unknown>,
  checks: Array<[key: string, allowed: readonly string[]]>
): McpToolResult | null {
  for (const [key, allowed] of checks) {
    const value = args[key]
    if (typeof value === 'string' && !allowed.includes(value)) {
      return failure('invalid_arguments', `"${key}" must be one of: ${allowed.join(', ')}.`)
    }
  }
  return null
}
