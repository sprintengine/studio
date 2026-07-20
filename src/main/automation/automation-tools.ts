import { isAbsolute } from 'path'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineAutomationReadResult,
  SprintEngineAutomationWriteResult,
  SprintEngineCliPermissionPreset,
  SprintEngineMutationRefreshData,
  SprintEngineProjectionReadResult,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskMutationRole,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
  TerminalSessionSnapshot,
} from '../../shared/electron-api'
import type { SprintEngineAutomationMode } from '../../shared/sprintengine/automation-types'
import type { SprintEngineTaskStatus, SprintEngineVcs } from '../../shared/sprintengine/run-types'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import type { SetSprintEngineAutomationModeInput } from '../sprintengine-automation-service'
import type {
  SprintEngineArtifactReviewAction,
  SprintEngineArtifactReviewPayload,
  SprintEngineVcsPayload,
} from '../ipc/sprintengine-ipc'
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
import type { RoadmapAppFrontDoor, RoadmapSteerAction } from '../roadmap-orchestrator'
import type { LoadedPlugin } from '../../shared/plugin-manifest'
import { buildAgentBacklogLink } from '../../shared/backlog/agent-links'
import { isValidBacklogSlug } from '../../shared/backlog/frontmatter'
import { renderSkillInvocationTemplate } from '../../shared/skill-invocation'
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

// The built-in Backlog skill id backlog.work installs and invokes; the skill
// contract (agent edits `status:` itself) owns item lifecycle, so the tool only
// records links (epic decision 7).
const BACKLOG_SKILL_ID = 'backlog'

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
  /**
   * The instance roadmap's read + plan + steer surface (MC-1693), resolved lazily
   * like the Automations front door (the orchestrator boots with the Automations
   * module, after these tools are constructed). Null while that module is disabled
   * or not yet loaded — the roadmap.* tools report that explicitly.
   */
  getRoadmapFrontDoor(): RoadmapAppFrontDoor | null
  /** Absolute run.yaml paths under <root>/.multi-code/sprintengine, newest first. */
  listSprintRunStatePaths(workspaceRoot: string): Promise<string[]>
  /** One run's projection.json via the sprint-engine artifact reader (main-owned). */
  readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>
  /**
   * Read a run's main-owned automation mode intent (`automation.json` beside
   * run.yaml). Injected so sprint.status can disclose the mode an orchestrator
   * cannot otherwise see. A `record` of null means no sidecar exists yet, which
   * the board treats as `manual`.
   */
  readSprintAutomationMode(input: { statePath: string }): Promise<SprintEngineAutomationReadResult>
  /**
   * Write a run's automation mode through the main-owned intent service (the
   * `sprint.status`/mobile-relay write path, not the renderer delegate — the
   * two-lane rule). Same-mode writes return `changed: false`.
   */
  setSprintAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult>
  /**
   * Re-arm a stopped scheduler for the run's current mode (the board's Resume).
   * Fire-and-forget: returns void and no-ops on a run the scheduler does not
   * hold; callers verify via sprint.status.
   */
  resumeSprintRun(statePath: string): void
  /**
   * Cancel a run: the composed operation the IPC channel uses — the engine
   * cancel op, then (on success) scheduler teardown so a paused/manual run with
   * live agents is also torn down. Composed at the wiring site.
   */
  cancelSprintRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  /**
   * Sprint steering (MC-1654), all main-owned `sprintEngineArtifacts` writes —
   * the two-lane rule, never the renderer delegate. Each returns a result
   * object and never throws; a `{ ok: false }` is surfaced as the tool's own
   * `_failed` code. Review mode is pinned `'user'` at the wiring site: external
   * callers are a human-proxy surface, never the auto-runner's `'auto-run'`.
   */
  reviewSprintArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction
  ): Promise<SprintEngineArtifactCommandResult>
  commentSprintTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  resolveSprintTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>
  setSprintTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>
  createSprintTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  updateSprintTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  /**
   * Sprint VCS + usage reads (MC-1655), main-owned like the steering block. PR
   * create/refresh run the engine's own `vcs` CLI (idempotent per the command)
   * and re-read the projection into the result `data`; a `{ ok: false }` carries
   * the CLI stdout/stderr the caller needs. `readSprintTokenUsage` computes the
   * report directly — it never throws, degrading to an empty/unmeasured report.
   */
  createSprintPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  refreshSprintPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  readSprintTokenUsage(statePath: string): Promise<SprintEngineTokenUsageReport>
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
  /**
   * Loaded CLI plugin manifests (`getPluginRegistry().loaded()`). backlog.work
   * composes the target CLI's native skill invocation from the matching
   * plugin's `skillIntegration.invocation.fileDropTemplate`; injected as a
   * backend so tests fake manifests.
   */
  listPlugins(): LoadedPlugin[]
  /**
   * Make a built-in skill present in the workspace's native harness dirs before
   * a launch reads its invocation (getStatus → install; the
   * `ensureBuiltinSkillInstalled` seam in app-services). Returns whether the
   * skill is now installed. A false result is non-fatal for backlog.work — the
   * response records `skillEnsured: false` and the composed prompt still states
   * the lifecycle contract.
   */
  ensureBuiltinSkillInstalled(workspaceRoot: string, skillId: string): Promise<boolean>
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

  // The launch-config fields agent.launch and backlog.work both accept:
  // `permissionPreset` (`bypass_all` refused with its own code, epic decision 4)
  // and `worktree` (an object with an optional name — never a bare cwd). Returns
  // the resolved options or a failure McpToolResult.
  function resolveLaunchOptions(
    args: Record<string, unknown>
  ): { permissionPreset?: SprintEngineCliPermissionPreset; worktreeRequested: boolean; worktreeName?: string } | McpToolResult {
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
    return {
      permissionPreset: optionalString(args.permissionPreset) as SprintEngineCliPermissionPreset | undefined,
      worktreeRequested,
      worktreeName,
    }
  }

  // Create the isolation worktree (when requested or forced by a connector),
  // delegate agent.launch to the renderer, and confirm the launch by a live
  // terminal session — the shared execution path for agent.launch and
  // backlog.work. Returns the confirmed workspace + agent id (and worktree
  // path), or a failure McpToolResult. The caller is expected to have validated
  // args and confirmed the workspace exists.
  async function launchConfiguredAgent(plan: {
    workspaceId: string
    cli?: string
    name?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: SprintEngineCliPermissionPreset
    specialistId?: string
    connectorId?: string
    worktreeRequested: boolean
    worktreeName?: string
  }): Promise<{ workspace: Workspace; agentId: string; worktreePath?: string } | McpToolResult> {
    // A connector launch forces a worktree even when none was requested — the
    // connector .mcp.json must never land in the user's checkout. Worktree
    // creation runs in main before delegating, and a failure here is fatal: the
    // caller asked for isolation, so we never silently fall back.
    let worktreePath: string | undefined
    if (plan.worktreeRequested || plan.connectorId) {
      const resolved = resolveWorkspaceRoot(plan.workspaceId)
      if (!('root' in resolved)) return resolved
      const derivedName = plan.worktreeName || plan.name || plan.connectorId || `agent-${now().toString(36)}`
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
      workspaceId: plan.workspaceId,
      cli: plan.cli,
      name: plan.name,
      prompt: plan.prompt,
      cliModel: plan.cliModel,
      permissionPreset: plan.permissionPreset,
      specialistId: plan.specialistId,
      connectorId: plan.connectorId,
      worktreePath,
    })
    if (!delegated.ok) return failure(delegated.code, delegated.message)
    const agentId = delegated.agentId
    if (!agentId) return failure('renderer_protocol_error', 'The renderer accepted the launch but returned no agent id.')
    const confirmed = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
      const workspace = findWorkspace(plan.workspaceId)
      if (!workspace) return null
      const agent = workspace.agents[agentId]
      const session = agentTerminalSession(plan.workspaceId, agentId, agent?.cliSessionId)
      return session?.processAlive ? workspace : null
    })
    if (!confirmed) {
      return failure(
        'launch_confirmation_timeout',
        `Agent "${agentId}" was added to workspace "${plan.workspaceId}" but no live terminal session registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms; treat the launch as unverified. Read agent.status for the current state.`
      )
    }
    return { workspace: confirmed, agentId, ...(worktreePath ? { worktreePath } : {}) }
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

      const options = resolveLaunchOptions(args)
      if ('content' in options) return options

      if (!findWorkspace(workspaceId)) {
        return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      }

      const launched = await launchConfiguredAgent({
        workspaceId,
        cli: optionalString(args.cli),
        name: optionalString(args.name),
        prompt: optionalString(args.prompt),
        cliModel: optionalString(args.cliModel),
        permissionPreset: options.permissionPreset,
        specialistId: optionalString(args.specialistId),
        connectorId: optionalString(args.connectorId),
        worktreeRequested: options.worktreeRequested,
        worktreeName: options.worktreeName,
      })
      if (!('agentId' in launched)) return launched
      return success({
        agent: agentProjection(launched.workspace, launched.agentId),
        ...(launched.worktreePath ? { worktreePath: launched.worktreePath } : {}),
      })
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
      + 'The item file is written with validated lifecycle and triage frontmatter, a server-owned precise updated timestamp, '
      + 'and collision-safe identity; new items start as status "idea".',
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
      + 'the item body is never touched and a real change gets a server-owned precise updated timestamp. '
      + 'Fields apply in a fixed order (status, type, triage, epic) and the first '
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

  // Compose the startup prompt for a backlog.work handoff: the target CLI's
  // native skill invocation (e.g. `/backlog backlog/foo.md` for Claude) when the
  // plugin declares a file-drop template, otherwise a plain-language block that
  // names the path and restates the built-in skill's lifecycle contract so any
  // agent can follow it. The invocation is what gets sent; the fallback is
  // CLI-agnostic, so it also covers an unspecified or unknown `cli`.
  function renderBacklogSkillInvocation(cli: string | undefined, relativePath: string): string {
    const plugin = cli ? backends.listPlugins().find((candidate) => candidate.manifest.id === cli) : undefined
    const template = plugin?.manifest.skillIntegration?.invocation?.fileDropTemplate
    if (template) {
      return renderSkillInvocationTemplate(template, { skillId: BACKLOG_SKILL_ID, skillName: 'Backlog', path: relativePath })
    }
    return (
      `Work the Backlog item at ${relativePath}. `
      + 'Track its lifecycle by editing the frontmatter `status:` line: set `in_progress` when you start, '
      + '`needs_input` (and state the blocking question) if you stop for input, and `completed` only after the '
      + 'work is real and verified. Leave the body and every other field untouched.'
    )
  }

  const backlogWork: McpToolRegistration = {
    name: 'backlog.work',
    description:
      'Hand a Backlog item to a freshly launched agent in one call: launches a configured agent whose first input '
      + "is the target CLI's Backlog skill invocation (e.g. \"/backlog <path>\" for Claude, a plain-language "
      + 'lifecycle block for CLIs without skill integration), then records the working-agent link. Never changes '
      + 'item status — the Backlog skill contract owns lifecycle, exactly like dragging the item onto a terminal. '
      + 'Refuses completed or archived items. Same launch fields as agent.launch (bypass_all refused), minus '
      + 'specialist/connector.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        path: { type: 'string', description: 'Item path relative to the workspace root, e.g. "backlog/example.md".' },
        cli: { type: 'string', description: 'Agent CLI plugin id (for example "claude-code" or "codex"); defaults to the last selected CLI.' },
        name: { type: 'string', description: 'Agent display name.' },
        cliModel: { type: 'string', description: 'Model id for CLIs that support model selection; forwarded verbatim.' },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description: 'CLI permission preset. Only "default" or "auto_workspace"; "bypass_all" is refused on this surface.',
        },
        worktree: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' } },
          additionalProperties: false,
          description: 'Isolate the agent in a git worktree on an "agent/<name>" branch instead of the workspace checkout.',
        },
        instructions: { type: 'string', description: 'Extra context appended after the skill invocation in the startup prompt.' },
      },
      required: ['workspaceId', 'path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'cliModel', 'instructions'])
      if (invalid) return invalid
      const options = resolveLaunchOptions(args)
      if ('content' in options) return options
      const resolved = resolveWorkspaceRoot(workspaceId)
      if (!('root' in resolved)) return resolved

      // Read the item and gate on workability: a missing/invalid path is
      // not_found; a completed item or anything under backlog/archived/ is a
      // finished record that must not be re-handed. Every other status
      // (including in_progress — a re-handoff is legitimate) is workable.
      const read = await backends.readBacklogItem(resolved.root, path)
      if (!read.ok) return failure('backlog_item_not_found', read.message)
      if (read.item.status === 'completed' || isArchivedBacklogPath(read.item.relativePath)) {
        const reason = read.item.status === 'completed' ? 'completed' : 'archived'
        return failure(
          'backlog_item_not_workable',
          `Backlog item ${read.item.relativePath} is ${reason} and cannot be handed to an agent.`
        )
      }

      const cli = optionalString(args.cli)
      const instructions = optionalString(args.instructions)
      const invocation = renderBacklogSkillInvocation(cli, read.item.relativePath)
      const prompt = instructions ? `${invocation}\n\n${instructions}` : invocation

      // Install the Backlog skill into the CLI's native dir before launch so the
      // invocation resolves. Non-fatal: a false result rides `skillEnsured` and
      // the prompt still states the lifecycle contract.
      const skillEnsured = await backends.ensureBuiltinSkillInstalled(resolved.root, BACKLOG_SKILL_ID)

      const launched = await launchConfiguredAgent({
        workspaceId,
        cli,
        name: optionalString(args.name),
        prompt,
        cliModel: optionalString(args.cliModel),
        permissionPreset: options.permissionPreset,
        worktreeRequested: options.worktreeRequested,
        worktreeName: options.worktreeName,
      })
      if (!('agentId' in launched)) return launched

      // Record the working-agent link after a confirmed launch. A link failure
      // here is NOT overall failure — the agent is already running, so faking
      // failure would invite a duplicate launch. Report assigned:false + warning.
      const agent = launched.workspace.agents[launched.agentId]
      const link = buildAgentBacklogLink({
        workspaceId,
        agentId: launched.agentId,
        agentName: agent?.name || launched.agentId,
      })
      const written = await backends.backlogWrite.addOrUpdateLink({
        workspaceRoot: resolved.root,
        relativePath: read.item.relativePath,
        link,
      })
      return success({
        worked: {
          relativePath: read.item.relativePath,
          workspaceId,
          agentId: launched.agentId,
          invocation,
          skillEnsured,
          assigned: written.ok,
          ...(written.ok ? {} : { warning: `Agent launched but the working-agent link was not recorded: ${written.message}` }),
          ...(launched.worktreePath ? { worktreePath: launched.worktreePath } : {}),
        },
      })
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

  // The three real automation modes; `paused` is not one of them — pause is
  // `manual`, matching the board (epic decision, no `paused` pseudo-mode).
  const SPRINT_AUTOMATION_MODES: readonly SprintEngineAutomationMode[] = [
    'manual',
    'run_agents',
    'run_agents_and_approve_artifacts',
  ]

  // The task-status vocabulary sprint.task.set_status validates against, mirrored
  // from SprintEngineTaskStatus (run-types.ts) — the `readonly [...]` typing fails
  // the build if any listed value leaves the union. The engine still rejects
  // illegal transitions; this only fails fast on a value that is not a status.
  const SPRINT_TASK_STATUSES: readonly SprintEngineTaskStatus[] = [
    'todo',
    'in_progress',
    'review',
    'needs_input',
    'done',
    'canceled',
  ]

  // The 9 roles sprint.task.create/update may assign, mirrored from
  // SprintEngineTaskMutationRole (electron-api.ts). Same build-time guard as the
  // statuses above: a value outside the union fails to compile here.
  const SPRINT_TASK_MUTATION_ROLES: readonly SprintEngineTaskMutationRole[] = [
    'architect',
    'product',
    'developer',
    'frontend',
    'tester',
    'security',
    'performance',
    'production_readiness_reviewer',
    'cross_platform',
  ]

  function sprintStatePath(root: string, slug: string): string {
    return [root, '.multi-code', 'sprintengine', slug, 'run.yaml'].join('/')
  }

  // Every sprint tool is keyed workspaceId + slug and NEVER accepts a caller
  // statePath: resolve the workspace root through the sync snapshot, validate
  // the slug against SPRINT_SLUG_RE, and reconstruct the statePath ourselves.
  function resolveSprintStatePath(args: Record<string, unknown>): { statePath: string; slug: string } | McpToolResult {
    const workspaceId = requireString(args, 'workspaceId')
    if (typeof workspaceId !== 'string') return workspaceId
    const slug = requireString(args, 'slug')
    if (typeof slug !== 'string') return slug
    if (!SPRINT_SLUG_RE.test(slug) || slug === '.' || slug === '..') {
      return failure('invalid_arguments', '"slug" must be a plain run slug from sprint.list.')
    }
    const resolved = resolveWorkspaceRoot(workspaceId)
    if (!('root' in resolved)) return resolved
    return { statePath: sprintStatePath(resolved.root, slug), slug }
  }

  // The mutation tools gate on the run actually existing on disk before writing:
  // a projection read that fails is an unknown run, not a mode/cancel failure.
  async function ensureSprintRunExists(statePath: string): Promise<McpToolResult | null> {
    const projection = await backends.readSprintEngineProjection(statePath)
    if (!projection.ok) return failure('sprint_not_found', projection.message)
    return null
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
      "One Sprint Engine run's current projection (goal, tasks, artifacts, roster, completion) read from disk, "
      + 'plus its main-owned automation mode (manual/run_agents/run_agents_and_approve_artifacts). automationMode '
      + 'is null only when the mode has never been set for this run (the board treats that as manual). Steer the '
      + 'mode with sprint.set_mode.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const projection = await backends.readSprintEngineProjection(resolvedRun.statePath)
      if (!projection.ok) return failure('sprint_status_failed', projection.message)
      // Automation mode is supplementary: a read failure discloses null rather
      // than failing the whole status read (the projection is the primary
      // payload). No sidecar record → manual, matching the board.
      const mode = await backends.readSprintAutomationMode({ statePath: resolvedRun.statePath })
      const automationMode: SprintEngineAutomationMode | null = mode.ok ? mode.record?.desiredMode ?? 'manual' : null
      return success({
        slug: resolvedRun.slug,
        projection: projection.data,
        changeToken: projection.token ?? null,
        automationMode,
      })
    },
  }

  const sprintSetMode: McpToolRegistration = {
    name: 'sprint.set_mode',
    description:
      "Set a Sprint Engine run's automation mode through the main-owned intent service. \"manual\" pauses the "
      + 'auto-runner (there is no separate paused state — pause is manual); "run_agents" runs agents; '
      + '"run_agents_and_approve_artifacts" also auto-approves review artifacts. Idempotent: setting the mode '
      + 'the run already has returns changed:false. Verify the live effect with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        mode: {
          type: 'string',
          enum: [...SPRINT_AUTOMATION_MODES],
          description: 'Target automation mode.',
        },
      },
      required: ['workspaceId', 'slug', 'mode'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const mode = requireString(args, 'mode')
      if (typeof mode !== 'string') return mode
      if (!SPRINT_AUTOMATION_MODES.includes(mode as SprintEngineAutomationMode)) {
        return failure('invalid_arguments', `"mode" must be one of: ${SPRINT_AUTOMATION_MODES.join(', ')}.`)
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const written = await backends.setSprintAutomationMode({
        statePath: resolvedRun.statePath,
        mode: mode as SprintEngineAutomationMode,
        actor: 'automation',
        reason: 'automation-server',
      })
      if (!written.ok) return failure('sprint_mode_failed', written.message)
      return success({ mode: written.record.desiredMode, changed: written.changed })
    },
  }

  const sprintResume: McpToolRegistration = {
    name: 'sprint.resume',
    description:
      "Re-arm a stopped Sprint Engine run's scheduler for its current mode (the board's Resume). Fire-and-forget: "
      + 'this requests a resume and gives no confirmation of the run reaching a running state — verify with '
      + 'sprint.status. Has no effect on a run the scheduler is not holding.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      backends.resumeSprintRun(resolvedRun.statePath)
      return success({ resumed: { slug: resolvedRun.slug, requested: true } })
    },
  }

  const sprintCancel: McpToolRegistration = {
    name: 'sprint.cancel',
    description:
      'Cancel a Sprint Engine run: writes run/task status through the engine cancel op, then tears down the '
      + "scheduler so a paused or manual run's live agents are also stopped. Terminal — a canceled run cannot be "
      + 'resumed.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const canceled = await backends.cancelSprintRun({ statePath: resolvedRun.statePath })
      if (!canceled.ok) {
        const detail = [canceled.stdout, canceled.stderr].filter((part) => Boolean(part && part.trim())).join('\n')
        return failure('sprint_cancel_failed', detail ? `${canceled.message}\n${detail}` : canceled.message)
      }
      return success({ canceled: { slug: resolvedRun.slug } })
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

  const sprintArtifactApprove: McpToolRegistration = {
    name: 'sprint.artifact.approve',
    description:
      "Approve a Sprint Engine run's review artifact (plan, spec review, etc.), the human-proxy approval the board "
      + 'offers. Direct-main, keyed workspaceId + slug; review mode is pinned to a human approval, never the '
      + "auto-runner's policy approval. Optional feedback rides the approval. Verify the effect with sprint.status.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        artifactId: { type: 'string', description: 'Artifact id from the run projection (sprint.status).' },
        feedback: { type: 'string', description: 'Optional note recorded with the approval.' },
      },
      required: ['workspaceId', 'slug', 'artifactId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const artifactId = requireString(args, 'artifactId')
      if (typeof artifactId !== 'string') return artifactId
      const invalid = firstInvalidOptionalString(args, ['feedback'])
      if (invalid) return invalid
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const reviewed = await backends.reviewSprintArtifact(
        { statePath: resolvedRun.statePath, artifactId, ...(optionalString(args.feedback) ? { feedback: optionalString(args.feedback) } : {}) },
        'approve'
      )
      if (!reviewed.ok) return sprintCommandResultFailure('sprint_artifact_approve_failed', reviewed)
      return success({ approved: { slug: resolvedRun.slug, artifactId } })
    },
  }

  const sprintArtifactRequestChanges: McpToolRegistration = {
    name: 'sprint.artifact.request_changes',
    description:
      "Request changes on a Sprint Engine run's review artifact, returning it to its author with required feedback. "
      + 'Direct-main, keyed workspaceId + slug. Feedback is required and non-empty at the tool boundary (the engine '
      + 'also enforces it). Verify the effect with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        artifactId: { type: 'string', description: 'Artifact id from the run projection (sprint.status).' },
        feedback: { type: 'string', description: 'Required note describing the changes to make.' },
      },
      required: ['workspaceId', 'slug', 'artifactId', 'feedback'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const artifactId = requireString(args, 'artifactId')
      if (typeof artifactId !== 'string') return artifactId
      const feedback = requireString(args, 'feedback')
      if (typeof feedback !== 'string') return feedback
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const reviewed = await backends.reviewSprintArtifact(
        { statePath: resolvedRun.statePath, artifactId, feedback },
        'request-changes'
      )
      if (!reviewed.ok) return sprintCommandResultFailure('sprint_artifact_request_changes_failed', reviewed)
      return success({ requestedChanges: { slug: resolvedRun.slug, artifactId } })
    },
  }

  const sprintTaskComment: McpToolRegistration = {
    name: 'sprint.task.comment',
    description:
      "Add a comment to a Sprint Engine task — the same board comment an operator leaves. Direct-main, keyed "
      + 'workspaceId + slug; the comment is visible to the task owner.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        body: { type: 'string', description: 'Comment body.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'body'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const body = requireString(args, 'body')
      if (typeof body !== 'string') return body
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const commented = await backends.commentSprintTask({ statePath: resolvedRun.statePath, taskId, body })
      if (!commented.ok) return sprintCommandResultFailure('sprint_task_comment_failed', commented)
      return success({ commented: { slug: resolvedRun.slug, taskId } })
    },
  }

  const sprintTaskResolveInput: McpToolRegistration = {
    name: 'sprint.task.resolve_input',
    description:
      "Answer a Sprint Engine task's needs_input question so its owner can resume. Direct-main, keyed workspaceId + "
      + 'slug. `resolution` is the answer; optional `complete` closes the task instead of returning it to work. '
      + 'Pairs with the run-needs-input trigger, whose payload carries the taskId + question.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        resolution: { type: 'string', description: 'The answer to the task\'s needs_input question.' },
        complete: { type: 'boolean', description: 'Close the task on resolution instead of returning it to work.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'resolution'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const resolution = requireString(args, 'resolution')
      if (typeof resolution !== 'string') return resolution
      if (args.complete !== undefined && typeof args.complete !== 'boolean') {
        return failure('invalid_arguments', '"complete" must be a boolean when provided.')
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const resolved = await backends.resolveSprintTaskInput({
        statePath: resolvedRun.statePath,
        taskId,
        resolution,
        ...(args.complete === true ? { complete: true } : {}),
      })
      if (!resolved.ok) return sprintCommandResultFailure('sprint_task_resolve_input_failed', resolved)
      return success({ resolved: { slug: resolvedRun.slug, taskId, complete: args.complete === true } })
    },
  }

  const sprintTaskSetStatus: McpToolRegistration = {
    name: 'sprint.task.set_status',
    description:
      "Set a Sprint Engine task's status (todo, in_progress, review, needs_input, done, canceled). Direct-main, "
      + 'keyed workspaceId + slug. The engine rejects illegal transitions; the common use is reopening a reviewed '
      + 'or done task with "in_progress" for rework under its original owner.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        status: { type: 'string', enum: [...SPRINT_TASK_STATUSES], description: 'Target task status.' },
      },
      required: ['workspaceId', 'slug', 'taskId', 'status'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const status = requireString(args, 'status')
      if (typeof status !== 'string') return status
      if (!SPRINT_TASK_STATUSES.includes(status as SprintEngineTaskStatus)) {
        return failure('invalid_arguments', `"status" must be one of: ${SPRINT_TASK_STATUSES.join(', ')}.`)
      }
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const set = await backends.setSprintTaskStatus({ statePath: resolvedRun.statePath, taskId, status })
      if (!set.ok) return sprintCommandResultFailure('sprint_task_set_status_failed', set)
      return success({ statusSet: { slug: resolvedRun.slug, taskId, status } })
    },
  }

  const sprintTaskCreate: McpToolRegistration = {
    name: 'sprint.task.create',
    description:
      'Add a task to a Sprint Engine run mid-flight. Direct-main, keyed workspaceId + slug. `role` must be an '
      + 'assignable Sprint Engine role. acceptanceCriteria / implementationNotes / notes are arrays of non-empty '
      + 'strings (a bare string is rejected). Verify the added task with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        title: { type: 'string', description: 'Task title.' },
        role: { type: 'string', enum: [...SPRINT_TASK_MUTATION_ROLES], description: 'Assigned role.' },
        description: { type: 'string', description: 'Task description / body.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria bullets.' },
        implementationNotes: { type: 'array', items: { type: 'string' }, description: 'Implementation hints.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Freeform notes.' },
      },
      required: ['workspaceId', 'slug', 'title', 'role'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const title = requireString(args, 'title')
      if (typeof title !== 'string') return title
      const role = requireString(args, 'role')
      if (typeof role !== 'string') return role
      if (!SPRINT_TASK_MUTATION_ROLES.includes(role as SprintEngineTaskMutationRole)) {
        return failure('invalid_arguments', `"role" must be one of: ${SPRINT_TASK_MUTATION_ROLES.join(', ')}.`)
      }
      const invalid = firstInvalidOptionalString(args, ['description'])
      if (invalid) return invalid
      const badArray = firstInvalidStringArray(args, ['acceptanceCriteria', 'implementationNotes', 'notes'])
      if (badArray) return badArray
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const created = await backends.createSprintTask({
        statePath: resolvedRun.statePath,
        title,
        role: role as SprintEngineTaskMutationRole,
        ...(optionalString(args.description) ? { description: optionalString(args.description) } : {}),
        ...(optionalStringArray(args.acceptanceCriteria) ? { acceptanceCriteria: optionalStringArray(args.acceptanceCriteria) } : {}),
        ...(optionalStringArray(args.implementationNotes) ? { implementationNotes: optionalStringArray(args.implementationNotes) } : {}),
        ...(optionalStringArray(args.notes) ? { notes: optionalStringArray(args.notes) } : {}),
      })
      if (!created.ok) return sprintCommandResultFailure('sprint_task_create_failed', created)
      return success({ created: { slug: resolvedRun.slug, title, role } })
    },
  }

  const sprintTaskUpdate: McpToolRegistration = {
    name: 'sprint.task.update',
    description:
      "Update an existing Sprint Engine task's fields (title, description, role, acceptanceCriteria, "
      + 'implementationNotes, notes). Direct-main, keyed workspaceId + slug. Only supplied fields change; array '
      + 'fields are arrays of non-empty strings (a bare string is rejected). Verify with sprint.status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        slug: { type: 'string', description: 'Run slug from sprint.list.' },
        taskId: { type: 'string', description: 'Task id from the run projection (sprint.status).' },
        title: { type: 'string', description: 'New task title.' },
        role: { type: 'string', enum: [...SPRINT_TASK_MUTATION_ROLES], description: 'Reassigned role.' },
        description: { type: 'string', description: 'New task description / body.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria bullets.' },
        implementationNotes: { type: 'array', items: { type: 'string' }, description: 'Implementation hints.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Freeform notes.' },
      },
      required: ['workspaceId', 'slug', 'taskId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const taskId = requireString(args, 'taskId')
      if (typeof taskId !== 'string') return taskId
      const invalid = firstInvalidOptionalString(args, ['title', 'description'])
      if (invalid) return invalid
      if (args.role !== undefined && !SPRINT_TASK_MUTATION_ROLES.includes(args.role as SprintEngineTaskMutationRole)) {
        return failure('invalid_arguments', `"role" must be one of: ${SPRINT_TASK_MUTATION_ROLES.join(', ')}.`)
      }
      const badArray = firstInvalidStringArray(args, ['acceptanceCriteria', 'implementationNotes', 'notes'])
      if (badArray) return badArray
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const updated = await backends.updateSprintTask({
        statePath: resolvedRun.statePath,
        taskId,
        ...(optionalString(args.title) ? { title: optionalString(args.title) } : {}),
        ...(args.role !== undefined ? { role: args.role as SprintEngineTaskMutationRole } : {}),
        ...(optionalString(args.description) ? { description: optionalString(args.description) } : {}),
        ...(optionalStringArray(args.acceptanceCriteria) ? { acceptanceCriteria: optionalStringArray(args.acceptanceCriteria) } : {}),
        ...(optionalStringArray(args.implementationNotes) ? { implementationNotes: optionalStringArray(args.implementationNotes) } : {}),
        ...(optionalStringArray(args.notes) ? { notes: optionalStringArray(args.notes) } : {}),
      })
      if (!updated.ok) return sprintCommandResultFailure('sprint_task_update_failed', updated)
      return success({ updated: { slug: resolvedRun.slug, taskId } })
    },
  }

  const sprintPrCreate: McpToolRegistration = {
    name: 'sprint.pr.create',
    description:
      "Open a Sprint Engine run's pull request through the engine's own VCS command. Direct-main, keyed workspaceId "
      + '+ slug; idempotent per the underlying command (re-opening an existing PR is safe). On success the run\'s '
      + 'refreshed vcs block (pull-request URL, branch, merge state) rides the payload so no second sprint.status is '
      + 'needed. A non-worktree run surfaces the engine\'s own refusal — the tool does not pre-empt it.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const created = await backends.createSprintPullRequest({ statePath: resolvedRun.statePath })
      if (!created.ok) return sprintCommandResultFailure('sprint_pr_failed', created)
      return success({ slug: resolvedRun.slug, vcs: sprintVcsFromCommandResult(created.data) })
    },
  }

  const sprintPrStatus: McpToolRegistration = {
    name: 'sprint.pr.status',
    description:
      "Refresh and read a Sprint Engine run's pull-request merge state. Direct-main, keyed workspaceId + slug; runs "
      + 'the engine pr-status probe (read-only, no working-tree mutation) then returns the refreshed vcs block. Read '
      + 'vcs.pullRequestState (open | merged | closed | null) from the payload — this is the precondition a landed-run '
      + 'trigger polls.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const refreshed = await backends.refreshSprintPullRequestStatus({ statePath: resolvedRun.statePath })
      if (!refreshed.ok) return sprintCommandResultFailure('sprint_pr_status_failed', refreshed)
      return success({ slug: resolvedRun.slug, vcs: sprintVcsFromCommandResult(refreshed.data) })
    },
  }

  const sprintTokenUsage: McpToolRegistration = {
    name: 'sprint.token_usage',
    description:
      "A Sprint Engine run's token accounting report (per-run totals, per-agent and per-task breakdowns, measurement "
      + 'coverage), computed from the run ledger and CLI transcripts. Direct-main, keyed workspaceId + slug. For '
      + 'budget-aware orchestration; unmeasured agents are reported as such, never as zero.',
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
      const resolvedRun = resolveSprintStatePath(args)
      if ('content' in resolvedRun) return resolvedRun
      // Gate on the run existing so a bad slug returns sprint_not_found rather
      // than the compute's truthful-but-misleading empty report for a run that
      // is not there (fallback discipline — no invented empty data).
      const missing = await ensureSprintRunExists(resolvedRun.statePath)
      if (missing) return missing
      const tokenUsage = await backends.readSprintTokenUsage(resolvedRun.statePath)
      return success({ slug: resolvedRun.slug, tokenUsage })
    },
  }

  // --- Roadmap tools (MC-1693): agents read, plan, and steer the ONE instance
  //     roadmap through the same sanctioned paths the global surface offers a human.
  //     The roadmap is instance-global (its home project is an app setting), so these
  //     tools take no workspaceId except add_step, where it names the source project
  //     for a cross-project step. ---

  function roadmapFrontDoorOrFailure(): RoadmapAppFrontDoor | McpToolResult {
    const frontDoor = backends.getRoadmapFrontDoor()
    if (!frontDoor) {
      return failure(
        'roadmap_module_unavailable',
        'The Roadmap orchestrator is disabled or not loaded in this app session; enable the Roadmap module in Settings → Modules.'
      )
    }
    return frontDoor
  }

  // Shape a front-door outcome into a tool result: a failure carries the message
  // (never fake success); a success echoes the optional structured `data`.
  function roadmapResult(code: string, outcome: { ok: boolean; message?: string }, data: Record<string, unknown>): McpToolResult {
    if (!outcome.ok) return failure(code, outcome.message ?? 'The roadmap operation failed.')
    return success(data)
  }

  const roadmapStatus: McpToolRegistration = {
    name: 'roadmap.status',
    description:
      "Read this Multicode's single instance roadmap — the board model the global surface renders. Each lane lists its "
      + 'steps with the project they belong to, a per-step state (done | running | up_next | queued | paused | unknown | '
      + 'unknown_project), and the lane\'s attention signal (approval | merge | paused | none). Read-only; returns '
      + '{ roadmap: null } when no roadmap is configured or active.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const frontDoor = roadmapFrontDoorOrFailure()
      if ('content' in frontDoor) return frontDoor
      const board = await frontDoor.readBoard()
      return success({ roadmap: board })
    },
  }

  const roadmapAddStep: McpToolRegistration = {
    name: 'roadmap.add_step',
    description:
      'Add a step to the instance roadmap: a backlog item, or an epic as one step (snapshotting its children, matching '
      + 'the UI). By default the item is from the home project that owns the roadmap; pass workspaceId to plan work from '
      + "another OPEN project (its alias is registered automatically). Appends to the last track unless `lane` names one. "
      + 'A malformed path, an unknown/unopened project, a missing item, or a duplicate is rejected with a message and the '
      + 'roadmap file is never touched.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Backlog item path relative to its project root, e.g. "backlog/foo.md" or "backlog/epics/bar.md".' },
        workspaceId: { type: 'string', description: 'Open workspace whose project the item belongs to; omit for the home project.' },
        lane: { type: 'string', description: 'Track (lane heading) to append to; defaults to the last track.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const frontDoor = roadmapFrontDoorOrFailure()
      if ('content' in frontDoor) return frontDoor
      const ref = requireString(args, 'ref')
      if (typeof ref !== 'string') return ref
      const invalid = firstInvalidOptionalString(args, ['workspaceId', 'lane'])
      if (invalid) return invalid
      let projectPath: string | undefined
      const workspaceId = optionalString(args.workspaceId)
      if (workspaceId) {
        const resolved = resolveWorkspaceRoot(workspaceId)
        if (!('root' in resolved)) return resolved
        projectPath = resolved.root
      }
      const outcome = await frontDoor.addStep({
        ref,
        ...(projectPath ? { projectPath } : {}),
        ...(optionalString(args.lane) ? { lane: optionalString(args.lane) } : {}),
        actor: 'automation',
      })
      return roadmapResult('roadmap_add_step_failed', outcome, { added: { ref: outcome.ref ?? ref } })
    },
  }

  const roadmapRemoveStep: McpToolRegistration = {
    name: 'roadmap.remove_step',
    description:
      'Remove a top-level step from the instance roadmap by its stored (authored) ref — the `ref` roadmap.status shows '
      + 'for the unit (project-qualified for a non-home step, e.g. "mobile:backlog/foo.md"). To drop a single snapshotted '
      + 'epic child instead, use roadmap.skip with the child ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The step\'s authored ref from roadmap.status (e.g. "backlog/foo.md" or "mobile:backlog/foo.md").' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const frontDoor = roadmapFrontDoorOrFailure()
      if ('content' in frontDoor) return frontDoor
      const ref = requireString(args, 'ref')
      if (typeof ref !== 'string') return ref
      const outcome = await frontDoor.removeStep({ ref, actor: 'automation' })
      return roadmapResult('roadmap_remove_step_failed', outcome, { removed: { ref } })
    },
  }

  const roadmapReorder: McpToolRegistration = {
    name: 'roadmap.reorder',
    description:
      "Move a step to a new position in the plan. `ref` is the step's authored ref (from roadmap.status); `toIndex` is "
      + 'its zero-based target position within the destination track. `toLane` moves it to a different track (defaults to '
      + 'its current track). The frontier is re-derived on the next refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The step\'s authored ref from roadmap.status.' },
        toIndex: { type: 'integer', minimum: 0, description: 'Zero-based target position within the destination track.' },
        toLane: { type: 'string', description: 'Destination track heading; defaults to the step\'s current track.' },
      },
      required: ['ref', 'toIndex'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const frontDoor = roadmapFrontDoorOrFailure()
      if ('content' in frontDoor) return frontDoor
      const ref = requireString(args, 'ref')
      if (typeof ref !== 'string') return ref
      if (typeof args.toIndex !== 'number' || !Number.isInteger(args.toIndex) || args.toIndex < 0) {
        return failure('invalid_arguments', '"toIndex" must be a non-negative integer.')
      }
      const invalid = firstInvalidOptionalString(args, ['toLane'])
      if (invalid) return invalid
      const outcome = await frontDoor.reorderStep({
        ref,
        toIndex: args.toIndex,
        ...(optionalString(args.toLane) ? { toLane: optionalString(args.toLane) } : {}),
        actor: 'automation',
      })
      return roadmapResult('roadmap_reorder_failed', outcome, { reordered: { ref } })
    },
  }

  const roadmapSkip: McpToolRegistration = {
    name: 'roadmap.skip',
    description:
      'Skip a step: remove it from the plan so the lane\'s frontier advances past it, recording a reason as an inert audit '
      + 'comment in the roadmap file. Never archives the backlog item (that would read as dangling and pause the lane). '
      + 'Accepts a top-level step ref or a single snapshotted epic child ref (both from roadmap.status). A reason is required.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The step (or epic child) authored ref from roadmap.status.' },
        reason: { type: 'string', description: 'Why the step is being skipped (recorded in the roadmap file).' },
      },
      required: ['ref', 'reason'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const frontDoor = roadmapFrontDoorOrFailure()
      if ('content' in frontDoor) return frontDoor
      const ref = requireString(args, 'ref')
      if (typeof ref !== 'string') return ref
      const reason = requireString(args, 'reason')
      if (typeof reason !== 'string') return reason
      const outcome = await frontDoor.skipStep({ ref, reason, actor: 'automation' })
      return roadmapResult('roadmap_skip_failed', outcome, { skipped: { ref } })
    },
  }

  // The four lane-steering tools (approve/merge/pause/resume) share one shape: name a
  // lane, forward to the front door's steer wrapper (which derives the roadmap ref),
  // and audit-log the agent action. Steering is a human-proxy surface, so every call
  // is recorded — "the agent merged it" is always reconstructible (decision 4).
  function roadmapSteerTool(config: {
    name: string
    action: RoadmapSteerAction
    description: string
    failureCode: string
  }): McpToolRegistration {
    return {
      name: config.name,
      description: config.description,
      inputSchema: {
        type: 'object',
        properties: { lane: { type: 'string', description: 'The lane (track heading) to steer, from roadmap.status.' } },
        required: ['lane'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const frontDoor = roadmapFrontDoorOrFailure()
        if ('content' in frontDoor) return frontDoor
        const lane = requireString(args, 'lane')
        if (typeof lane !== 'string') return lane
        const outcome = await frontDoor.steerLane(lane, config.action, 'automation')
        return roadmapResult(config.failureCode, outcome, { [config.action]: { lane } })
      },
    }
  }

  const roadmapApprove = roadmapSteerTool({
    name: 'roadmap.approve',
    action: 'approve',
    failureCode: 'roadmap_approve_failed',
    description:
      "Approve the next start for a lane waiting on you (attention \"approval\"). Consumes the lane's pending approval so "
      + 'the orchestrator dispatches the next sprint on its next tick. Fails when the lane has no pending approval.',
  })
  const roadmapMerge = roadmapSteerTool({
    name: 'roadmap.merge',
    action: 'merge',
    failureCode: 'roadmap_merge_failed',
    description:
      "Merge a lane's delivered run (attention \"merge\") through the engine's own single-repo merge primitive — the same "
      + 'action the board offers. The engine re-checks merge order and is idempotent; a refusal (conflict/order/gh) surfaces '
      + 'as the failure message. Fails when the lane has no run to merge.',
  })
  const roadmapPause = roadmapSteerTool({
    name: 'roadmap.pause',
    action: 'pause',
    failureCode: 'roadmap_pause_failed',
    description:
      'Hold a lane at your request: the orchestrator stops advancing/merging/starting-next for it without touching the '
      + 'running sprint. Resume is the only exit. A no-op when the lane is already paused/parked.',
  })
  const roadmapResume = roadmapSteerTool({
    name: 'roadmap.resume',
    action: 'resume',
    failureCode: 'roadmap_resume_failed',
    description:
      'Resume a paused or parked lane. A manual pause continues exactly where it was; a failure park re-plans a fresh sprint '
      + 'from the same item (abandoning the dead run first). Verify the effect with roadmap.status.',
  })

  return [
    roadmapStatus,
    roadmapAddStep,
    roadmapRemoveStep,
    roadmapReorder,
    roadmapSkip,
    roadmapApprove,
    roadmapMerge,
    roadmapPause,
    roadmapResume,
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
    backlogWork,
    automationList,
    automationRuns,
    automationCreate,
    automationRun,
    sprintList,
    sprintStatus,
    sprintCreate,
    sprintSetMode,
    sprintResume,
    sprintCancel,
    sprintArtifactApprove,
    sprintArtifactRequestChanges,
    sprintTaskComment,
    sprintTaskResolveInput,
    sprintTaskSetStatus,
    sprintTaskCreate,
    sprintTaskUpdate,
    sprintPrCreate,
    sprintPrStatus,
    sprintTokenUsage,
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

// Archived items live under backlog/archived/ (path-derived, matching the
// renderer's isArchivedBacklogPath); readBacklogItem normalizes the path but is
// case-preserving, so lowercase before the prefix check.
function isArchivedBacklogPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').toLowerCase().startsWith('backlog/archived/')
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

// A sprint steering backend returns a SprintEngineArtifactCommandResult; on
// failure, surface the tool's own `_failed` code carrying the engine message
// plus any stdout/stderr (the sprint.cancel precedent), so a CLI-level failure
// is not flattened to a bare message.
function sprintCommandResultFailure(
  code: string,
  result: { message: string; stdout?: string; stderr?: string }
): McpToolResult {
  const detail = [result.stdout, result.stderr].filter((part) => Boolean(part && part.trim())).join('\n')
  return failure(code, detail ? `${result.message}\n${detail}` : result.message)
}

// A VCS command result re-reads the run projection into `data.projectionContent`
// (a JSON string). Pull the `vcs` block out of it so pr.create/pr.status callers
// read the pull-request URL and merge state without a second sprint.status. A
// non-worktree run has no `vcs` (null), and a malformed/absent projection reads
// back as null rather than throwing at this read-only boundary.
function sprintVcsFromCommandResult(data: SprintEngineMutationRefreshData): SprintEngineVcs | null {
  if (typeof data.projectionContent !== 'string') return null
  try {
    const parsed = JSON.parse(data.projectionContent) as { vcs?: SprintEngineVcs | null }
    return parsed.vcs ?? null
  } catch {
    return null
  }
}

// Array-field validation is load-bearing at this boundary: the Python engine has
// a history of spreading a bare string char-by-char, so acceptanceCriteria /
// implementationNotes / notes must each be an array of non-empty strings or the
// call is rejected here — never passed through. Returns the first offender.
function firstInvalidStringArray(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      return failure('invalid_arguments', `"${key}" must be an array of non-empty strings.`)
    }
  }
  return null
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined
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
