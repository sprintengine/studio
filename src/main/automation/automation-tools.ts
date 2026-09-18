import { isAbsolute } from 'path'
import type { RepositoryIdentity } from '../../shared/repository-identity'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { CliPermissionPreset, TerminalSessionSnapshot } from '../../shared/electron-api'
import { projectColorKey, projectHue } from '../../shared/project-hue'
import { normalizeCliPermissionPreset } from '../../shared/cli-permission-preset'
import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import { AUTOMATION_DEFAULT_PERMISSION_PRESET } from '../../shared/automations/contracts'
import { mobileSnapshotCollections } from '../../../packages/mobile-control-protocol/src/index'
import type { Workspace } from '../../renderer/src/types/workspace'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCriticalityPayload,
  BacklogDependenciesPlannedInput,
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
import type {
  BacklogIntegrityRepairInput,
  BacklogIntegrityRepairResult,
  BacklogListItemsResult,
  BacklogReadItemResult,
} from '../backlog-service'
import type { AutomationStoreListResult } from '../automations/store'
import type { AutomationsAppFrontDoor } from '../ipc/automations-ipc'
import type { LoadedPlugin } from '../../shared/plugin-manifest'
import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api'
import {
  MARKETPLACE_COMPONENT_KINDS,
  type MarketplaceComponentKind,
  type MarketplacePluginEntry,
} from '../../shared/marketplace/manifest'
import {
  BUNDLED_MODULE_IDS,
  type CapabilityManifest,
  type ThirdPartyModuleListResult,
  type ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { isDevOnlyModule } from '../../shared/modules/dev-only'
import type { ModuleRegistryEntry, ModuleRegistrySnapshot } from '../../shared/modules/registry-snapshot'
import { buildAgentBacklogLink } from '../../shared/backlog/agent-links'
// The built-in Backlog skill id backlog.work installs and invokes, and the
// plain-language handoff it falls back to. Both come from the shared module the
// renderer's "Hand to agent" reads too, so the same handoff is worded the same
// way whichever door it comes through. The skill contract owns item lifecycle
// through backlog.update; this tool only launches the agent and records links
// (epic decision 7).
import { BACKLOG_SKILL_ID, backlogLifecycleHandoffPrompt } from '../../shared/backlog/handoff-prompt'
import { renderSkillInvocationTemplate } from '../../shared/skill-invocation'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from './mcp-socket-server'
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../workspace-registry-service'
import type { WorkspaceMutationActor } from '../workspace-sync-service'
import { getWorkspaceChangeSummary } from '../workspace-change-summary'

// The automation tool surface. v1: workspace.create / workspace.list /
// workspace.status / agent.launch / agent.status; the read expansion adds
// backlog.list / backlog.read / automation.list / automation.runs. Reads and
// mutations alike answer from main's own services — there is one lane, and it is
// main's (MC-2161). No tool on this surface needs a window, and the renderer
// delegate that used to carry mutations, along with its `no_primary_window` /
// `renderer_timeout` error class, is gone. Mutations that have to be observed
// before success is reported are confirmed against the state main itself minted
// (the workspace-sync bus, the live terminal session).

const LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const CONFIRM_POLL_INTERVAL_MS = 150

// External callers get only these two presets; `bypass` is refused at the
// tool boundary everywhere (epic decision 4, same policy as automation.create).
// Order matters: the first entry is what an omitted preset resolves to.
const LAUNCH_PERMISSION_PRESETS = ['manual', 'auto'] as const

// The built-in action kinds that launch a CLI agent, and so resolve a permission
// preset (`runLocalAutomationAction` dispatches on exactly these two literals;
// `run-skill-loop` reuses `parseSpawnAgentConfig`). Local because the automation
// contracts carry no exported list yet — collapse this into one when they do.
const AGENT_BACKED_ACTION_KINDS: readonly string[] = ['spawn-agent', 'run-skill-loop']

export type AutomationBackends = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  listTerminalSessions(): TerminalSessionSnapshot[]
  /** Compose and spawn an agent in main (MC-2159). */
  launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult>
  /**
   * This machine's own agent-spawn permission preset, from the main-owned
   * launch settings store (MC-2154); `null` when the user has never chosen one.
   *
   * Read by `terminal.create` so a remotely-opened terminal runs under the
   * preset the person at this machine chose — and read HERE rather than left to
   * the launch service, because the surface's `bypass` ceiling has to be
   * applied before the pty exists, not after. The CLI default needs no such
   * accessor: the launch service resolves it from the same store and says so
   * when there is none.
   */
  getAgentSpawnPermissionDefault(): CliPermissionPreset | null
  /**
   * Mint a workspace in main's registry (MC-2158). Synchronous and
   * window-independent: `workspace.create` no longer asks a renderer to build
   * the record and then polls the bus to see whether it appeared.
   */
  createWorkspace(
    input: WorkspaceCreateRequest,
    actor: WorkspaceMutationActor,
  ): { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string }
  /** Read-only backlog listing for a workspace root (files + frontmatter, no writes). */
  listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>
  /** Read one backlog item (validated backlog/ relative path). */
  readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>
  /** Automation definitions from the workspace's .sprintengine/automations store. */
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
   * Create a git worktree for a widened agent.launch (model/preset launches
   * that request isolation, and every connector launch). Worktree
   * creation is renderer-adjacent but git-bound, so it happens in main before
   * delegating — the automations executor precedent. Returns the created
   * absolute path + branch, or `{ error }` (non-git folder, name collision,
   * git failure) which the tool surfaces as `worktree_unavailable`. Injected as
   * a backend so tests fake it.
   */
  createAgentWorktree(input: {
    workspaceRoot: string
    name: string
    /** The ref the worktree branches from; the checkout's HEAD when absent. */
    baseRef?: string
  }): Promise<{ worktreePath: string; branch: string } | { error: string }>
  /**
   * Which repository a folder is a clone of (one-project-across-machines):
   * its primary remote, normalised. Null for a non-repo or a remote-less one.
   * Served on `workspace.list` so a paired Studio can match this machine's
   * copy of a repository to its own. Cached in main; never throws.
   */
  readRepositoryIdentity(folderPath: string): Promise<RepositoryIdentity | null>
  /**
   * The checkout facts a remote launch panel needs before choosing where a
   * chat runs (checkout-and-branch-on-remote-create): whether the folder is
   * a repository, its branch, the trunk, every local branch, and the
   * worktrees the repository holds. Read-only; never throws for a non-repo
   * (that is the `git: false` answer).
   */
  readWorkspaceCheckout(workspaceRoot: string): Promise<{
    git: boolean
    branch: string | null
    defaultBranch: string | null
    branches: Array<{ name: string; current: boolean }>
    worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
  }>
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
  /**
   * The module registry as the renderer resolves it (MC-2078), mirrored into
   * main. Null until a window has pushed one — the module tools report that
   * explicitly rather than answering from main's own half of the universe,
   * which knows nothing about renderer-only modules (Backlog, Design, Git, …).
   */
  getModuleRegistrySnapshot(): ModuleRegistrySnapshot | null
  /**
   * Installed third-party modules with the trust + launch readiness only main
   * can compute (signature verification and the trust store live here). An
   * untrusted module never reaches the renderer registry, so this is also how
   * `module.list` sees that it is installed at all.
   */
  listInstalledThirdPartyModules(): Promise<ThirdPartyModuleListResult>
  /** Gateway tools contributed by capability modules, by owner (MC-1855). */
  listModuleContributedTools(): ReadonlyArray<{ moduleId: string; toolName: string }>
  /**
   * The marketplace registry index through the same client, cache, and
   * bundled-first policy the Extensions storefront reads (`marketplace:registry:read`)
   * — one source of truth, not a second fetch path.
   */
  readMarketplaceRegistry(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
  /**
   * The mobile companion's read model and command lane, served over the
   * gateway so a tailnet-paired phone works without the relay
   * (tailnet-mobile-transport, self-hosted-relay epic). Snapshots come back
   * in the same path-token form the relay serves — the phone round-trips
   * `ws_` tokens, never local paths — and commands run through the same
   * MobileControlCommandService the relay bridge dispatches to, so the
   * two transports cannot drift in behaviour.
   */
  mobileControl: {
    readSnapshot(input: {
      include?: string[]
      knownSnapshotVersion?: string
    }): Promise<{ unchanged: true; snapshotVersion: string } | { unchanged: false; snapshot: Record<string, unknown> }>
    dispatchCommand(input: {
      type: string
      payload: Record<string, unknown>
      deviceId: string
      idempotencyKey: string
      expectedSnapshotVersion?: string
    }): Promise<
      | { ok: true; commandId: string; commandType: string; executedAt: string; data: unknown }
      | { ok: false; code: string; message: string }
    >
  }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type BacklogWriteBackends = {
  updateStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>
  updateType(input: BacklogTypeInput): Promise<BacklogMutationResult>
  updateTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>
  updateEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>
  updateDependenciesPlanned(input: BacklogDependenciesPlannedInput): Promise<BacklogMutationResult>
  addOrUpdateLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>
  repairIntegrity(input: BacklogIntegrityRepairInput): Promise<BacklogIntegrityRepairResult>
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
    return (
      backends.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
    )
  }

  // Backlog and Automations services speak absolute workspace roots; tools
  // speak workspace ids. Resolution goes through main's registry, so a tool can
  // only ever reach app-known folders. A restart survivor resolves like any
  // other workspace now (MC-2158): main persists the real record, so there is
  // no longer a half-known placeholder to refuse or to except a live terminal
  // from.
  function resolveWorkspaceRoot(workspaceId: string): { root: string } | McpToolResult {
    const workspace = findWorkspace(workspaceId)
    if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    if (!workspace.folderPath) {
      return failure(
        'workspace_without_folder',
        `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`,
      )
    }
    return { root: workspace.folderPath }
  }

  // Backlog tools address a project folder, not the workspace registry: the
  // connection's advisory workspace identity resolves the folder for
  // Studio-launched agents, and callers outside the app pass an absolute
  // `projectRoot` instead. There is deliberately no open-workspace gate on the
  // folder — the socket's trust boundary is the local OS user, and
  // backlog-service validates the folder itself.
  function resolveBacklogRoot(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): { root: string } | McpToolResult {
    if (args.projectRoot !== undefined) {
      if (typeof args.projectRoot !== 'string' || !isAbsolute(args.projectRoot)) {
        return failure('invalid_arguments', '"projectRoot" must be an absolute path to the project folder.')
      }
      return { root: args.projectRoot }
    }
    const workspace = connectionWorkspace(context)
    if (workspace?.folderPath) return { root: workspace.folderPath }
    return failure(
      'project_root_required',
      'This connection has no resolvable workspace to default from; pass "projectRoot" (the absolute path to the project folder).',
    )
  }

  function connectionWorkspace(context: McpConnectionContext | undefined): Workspace | null {
    const workspaceId = context?.metadata.workspaceId
    return workspaceId ? findWorkspace(workspaceId) : null
  }

  // backlog.assign and backlog.work additionally need the live app workspace
  // record (the agent registry and the renderer launch delegate), so they
  // resolve to the connection's own workspace, or to the open workspace whose
  // folder matches an explicit projectRoot.
  function resolveBacklogWorkspace(
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): { workspace: Workspace; root: string } | McpToolResult {
    if (args.projectRoot !== undefined) {
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const workspace =
        backends
          .getWorkspaceSyncSnapshot()
          .state.workspaces.find((candidate) => candidate.folderPath === resolved.root) ?? null
      if (!workspace?.folderPath) {
        return failure(
          'workspace_not_open',
          `No open workspace uses the folder "${resolved.root}"; this tool needs that project open in the app.`,
        )
      }
      return { workspace, root: workspace.folderPath }
    }
    const workspace = connectionWorkspace(context)
    if (workspace?.folderPath) return { workspace, root: workspace.folderPath }
    return failure(
      'project_root_required',
      'This connection has no resolvable workspace to default from; pass "projectRoot" (the absolute path to the project folder).',
    )
  }

  function workspaceWindowId(workspaceId: string): string | null {
    const { workspaceWindows } = backends.getWorkspaceSyncSnapshot().state
    return workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))?.id ?? null
  }

  function agentTerminalSession(
    workspaceId: string,
    agentId: string,
    cliSessionId?: string,
  ): TerminalSessionSnapshot | null {
    return (
      backends
        .listTerminalSessions()
        .find(
          (session) =>
            session.kind === 'agent' &&
            session.workspaceId === workspaceId &&
            (session.agentId === agentId || (cliSessionId !== undefined && session.sessionId === cliSessionId)),
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
      detail: 'full',
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

  // The `permissionPreset` argument every launching tool accepts, validated
  // once: `bypass` is refused with its own code (epic decision 4) rather
  // than folded into invalid_arguments, because "you may not ask for that here"
  // and "that is not a preset" are different answers to the caller. Returns the
  // named preset, `undefined` when the caller named none, or the failure.
  function validatePermissionPreset(args: Record<string, unknown>): CliPermissionPreset | undefined | McpToolResult {
    if (args.permissionPreset === undefined) return undefined
    if (typeof args.permissionPreset !== 'string') {
      return failure('invalid_arguments', '"permissionPreset" must be a string when provided.')
    }
    // Normalize first so the refusal below catches BOTH spellings of bypass: an
    // external caller written before MC-2210 still sends `bypass_all`, and a
    // refusal that only matched the new name would let the old one straight
    // through the ceiling this surface exists to enforce.
    const requested = normalizeCliPermissionPreset(args.permissionPreset as CliPermissionPreset)
    if (requested === 'bypass') {
      return failure(
        'permission_preset_not_allowed',
        'Agents launched over the automation surface may not use permissionPreset "bypass". ' +
          'A person can set that preset in the app if it is genuinely needed.',
      )
    }
    if (!LAUNCH_PERMISSION_PRESETS.includes(args.permissionPreset as (typeof LAUNCH_PERMISSION_PRESETS)[number])) {
      return failure('invalid_arguments', `"permissionPreset" must be one of: ${LAUNCH_PERMISSION_PRESETS.join(', ')}.`)
    }
    return args.permissionPreset as CliPermissionPreset
  }

  // The launch-config fields agent.launch and backlog.work both accept:
  // `permissionPreset` (`bypass` refused with its own code, epic decision 4)
  // and `worktree` (an object with an optional name — never a bare cwd). Returns
  // the resolved options or a failure McpToolResult.
  function resolveLaunchOptions(args: Record<string, unknown>):
    | {
        permissionPreset?: CliPermissionPreset
        worktreeRequested: boolean
        worktreeName?: string
        worktreeBaseRef?: string
      }
    | McpToolResult {
    const preset = validatePermissionPreset(args)
    if (preset !== undefined && typeof preset !== 'string') return preset
    let worktreeRequested = false
    let worktreeName: string | undefined
    let worktreeBaseRef: string | undefined
    if (args.worktree !== undefined) {
      if (typeof args.worktree !== 'object' || args.worktree === null || Array.isArray(args.worktree)) {
        return failure('invalid_arguments', '"worktree" must be an object with an optional "name".')
      }
      const rawName = (args.worktree as { name?: unknown }).name
      if (rawName !== undefined && typeof rawName !== 'string') {
        return failure('invalid_arguments', '"worktree.name" must be a string when provided.')
      }
      const rawBaseRef = (args.worktree as { baseRef?: unknown }).baseRef
      if (rawBaseRef !== undefined && typeof rawBaseRef !== 'string') {
        return failure('invalid_arguments', '"worktree.baseRef" must be a string when provided.')
      }
      worktreeRequested = true
      worktreeName = optionalString(rawName)
      worktreeBaseRef = optionalString(rawBaseRef)
    }
    return {
      // Always resolved, never forwarded as undefined: the renderer fills an
      // absent preset from the user's last spawn choice, which ships as
      // `bypass` — so omitting the key reached the preset this surface
      // refuses. An external caller that names none gets the most restrictive
      // allowed value.
      permissionPreset:
        (optionalString(args.permissionPreset) as CliPermissionPreset | undefined) ?? LAUNCH_PERMISSION_PRESETS[0],
      worktreeRequested,
      worktreeName,
      worktreeBaseRef,
    }
  }

  // Create the isolation worktree (when requested or forced by a connector),
  // compose and spawn the agent in main, and confirm the launch by the live
  // terminal session main itself minted — the shared execution path for
  // agent.launch and backlog.work. Returns the confirmed workspace + agent id
  // (and worktree path), or a failure McpToolResult. The caller is expected to
  // have validated args and confirmed the workspace exists.
  async function launchConfiguredAgent(plan: {
    workspaceId: string
    cli?: string
    name?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: CliPermissionPreset
    connectorId?: string
    worktreeRequested: boolean
    worktreeName?: string
    worktreeBaseRef?: string
  }): Promise<
    | {
        workspace: Workspace
        agentId: string
        session: TerminalSessionSnapshot
        worktreePath?: string
        worktreeBranch?: string
      }
    | McpToolResult
  > {
    // A connector launch forces a worktree even when none was requested — the
    // connector .mcp.json must never land in the user's checkout. Worktree
    // creation runs in main before delegating, and a failure here is fatal: the
    // caller asked for isolation, so we never silently fall back.
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    if (plan.worktreeRequested || plan.connectorId) {
      const resolved = resolveWorkspaceRoot(plan.workspaceId)
      if (!('root' in resolved)) return resolved
      const derivedName = plan.worktreeName || plan.name || plan.connectorId || `agent-${now().toString(36)}`
      const created = await backends.createAgentWorktree({
        workspaceRoot: resolved.root,
        name: derivedName,
        ...(plan.worktreeBaseRef ? { baseRef: plan.worktreeBaseRef } : {}),
      })
      if ('error' in created) {
        return failure(
          'worktree_unavailable',
          `Could not create an isolated worktree for the launch (${created.error}). The folder must be a git repository.`,
        )
      }
      worktreePath = created.worktreePath
      worktreeBranch = created.branch
    }

    // Composed and spawned in main (MC-2159). Previously this delegated to the
    // primary window, which is why `agent.launch` and `backlog.work` failed
    // outright with no window open — the composition lived in a React hook, not
    // because anything about the launch needed a UI.
    const launched = await backends.launchAgent({
      workspaceId: plan.workspaceId,
      cli: plan.cli,
      name: plan.name,
      prompt: plan.prompt,
      cliModel: plan.cliModel,
      permissionPreset: plan.permissionPreset,
      connectorId: plan.connectorId,
      worktreePath,
    })
    if (!launched.ok) return failure(launched.code, launched.message)
    const { agentId, sessionId } = launched
    // Confirmation is still a LIVE terminal session, not the launch call
    // returning — a spawn can report success and the CLI can die immediately.
    // It now watches the session main actually minted rather than waiting for a
    // renderer to write an agent record, so it confirms identically with or
    // without a window (the 20s window is unchanged).
    const live = await waitFor(LAUNCH_CONFIRM_TIMEOUT_MS, () => {
      const session = backends.listTerminalSessions().find((candidate) => candidate.sessionId === sessionId)
      return session?.processAlive ? session : null
    })
    if (!live) {
      return failure(
        'launch_confirmation_timeout',
        `Agent "${agentId}" was launched in workspace "${plan.workspaceId}" but no live terminal session registered within ${LAUNCH_CONFIRM_TIMEOUT_MS}ms; treat the launch as unverified. Read agent.status for the current state.`,
      )
    }
    // The workspace record is only the shape callers project; main has held it
    // since before the launch (the service resolved the launch against this same
    // snapshot), so it is read once here rather than polled — waiting on it
    // would report a launch timeout for something that is not a launch problem.
    const workspace = findWorkspace(plan.workspaceId)
    if (!workspace) {
      return failure('unknown_workspace', `Workspace "${plan.workspaceId}" is not known to the running app.`)
    }
    // `live` is the session the launch actually minted, carried out so a caller
    // that needs the session id (terminal.create, whose whole point is the
    // immediate attach) reads the confirmed one rather than re-searching for it.
    return {
      workspace,
      agentId,
      session: live,
      ...(worktreePath ? { worktreePath } : {}),
      ...(worktreeBranch ? { worktreeBranch } : {}),
    }
  }

  const workspaceList: McpToolRegistration = {
    name: 'workspace.list',
    description:
      'List the workspaces visible to the user in the running Multicode instance, with window assignment and agent ids. ' +
      'Workspaces that survived a restart are listed like any other: main owns the registry, so their name, ' +
      'folder, mode, and agents are real whether or not a window is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { state } = backends.getWorkspaceSyncSnapshot()
      // The repository each folder is a clone of rides the listing
      // (one-project-across-machines): it is how a paired Studio recognises
      // its own project on this machine. Read per folder, cached in main.
      const workspaces = await Promise.all(
        state.workspaces.map(async (workspace) => ({
          ...workspaceProjection(workspace),
          repository: workspace.folderPath ? await backends.readRepositoryIdentity(workspace.folderPath) : null,
        })),
      )
      return success({
        workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        primaryWindowId: state.primaryWorkspaceWindowId,
      })
    },
  }

  // ── Mobile companion over the gateway ────────────────────────────────────
  // tailnet-mobile-transport (self-hosted-relay epic): the phone's snapshot
  // and command lane without the relay. v1 deliberately serves the epic's
  // acceptance set and nothing more; widening the command allowlist is a
  // decision, not a default.
  const MOBILE_GATEWAY_COMMAND_TYPES = ['backlog.update'] as const

  const workspaceSnapshot: McpToolRegistration = {
    name: 'workspace.snapshot',
    description:
      'The mobile companion snapshot: backlog, automations and the dev servers published on the tailnet as one ' +
      'versioned document, in the same path-token form the relay serves (ws_ tokens round-trip; local paths never leave ' +
      'the desktop). Pass knownSnapshotVersion from the previous read to get an {unchanged: true} marker ' +
      'instead of the full document when nothing moved.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: [...mobileSnapshotCollections] },
          description: `Collections to include (${mobileSnapshotCollections.join(', ')}). Defaults to all of them.`,
        },
        knownSnapshotVersion: { type: 'string', description: 'The snapshotVersion returned by the previous read.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalidArray = firstInvalidStringArray(args, ['include'])
      if (invalidArray) return invalidArray
      // Checked here rather than left to the bridge, which drops unknown names and
      // falls back to the default set: a caller that misspells a collection would
      // otherwise get a full snapshot and no hint that its scope was ignored.
      const collections: readonly string[] = mobileSnapshotCollections
      const unknownCollection = optionalStringArray(args.include)?.find((entry) => !collections.includes(entry))
      if (unknownCollection !== undefined) {
        return failure(
          'invalid_arguments',
          `"include" names "${unknownCollection}", which is not a snapshot collection. ` +
            `Collections: ${mobileSnapshotCollections.join(', ')}.`,
        )
      }
      const invalidString = firstInvalidOptionalString(args, ['knownSnapshotVersion'])
      if (invalidString) return invalidString
      const result = await backends.mobileControl.readSnapshot({
        include: optionalStringArray(args.include),
        knownSnapshotVersion: optionalString(args.knownSnapshotVersion),
      })
      return success(result)
    },
  }

  const workspaceMobileCommand: McpToolRegistration = {
    name: 'workspace.mobile_command',
    description:
      'Dispatch one mobile-control command envelope from a paired companion device — the same commands the phone ' +
      `sends over the relay, over this transport instead. Served types: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}. ` +
      'The device identity comes from the transport, never from the arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `One of: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}.` },
        payload: {
          type: 'object',
          description: 'The command payload, exactly as the mobile-control protocol defines it.',
        },
        idempotencyKey: { type: 'string', description: 'Client-chosen key; replays return the recorded result.' },
        expectedSnapshotVersion: { type: 'string' },
      },
      required: ['type', 'payload', 'idempotencyKey'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const type = requireString(args, 'type')
      if (typeof type !== 'string') return type
      const idempotencyKey = requireString(args, 'idempotencyKey')
      if (typeof idempotencyKey !== 'string') return idempotencyKey
      const invalidString = firstInvalidOptionalString(args, ['expectedSnapshotVersion'])
      if (invalidString) return invalidString
      if (!(MOBILE_GATEWAY_COMMAND_TYPES as readonly string[]).includes(type)) {
        return failure(
          'command_not_supported',
          `Mobile command "${type}" is not served over the gateway (served: ${MOBILE_GATEWAY_COMMAND_TYPES.join(', ')}).`,
        )
      }
      const payload = args.payload
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return failure('invalid_arguments', '"payload" must be an object.')
      }
      // The transport proved which paired device is calling (remote-tailnet
      // metadata is set server-side); a local-socket caller is the owner's own
      // machine and is labelled as such rather than trusted to name a device.
      const metadata = context?.metadata
      const deviceId =
        metadata?.kind === 'remote-tailnet' && metadata.deviceId
          ? metadata.deviceId
          : `local:${metadata?.kind ?? 'unknown'}`
      const result = await backends.mobileControl.dispatchCommand({
        type,
        payload: payload as Record<string, unknown>,
        deviceId,
        idempotencyKey,
        expectedSnapshotVersion: optionalString(args.expectedSnapshotVersion),
      })
      if (!result.ok) return failure(result.code, result.message)
      return success({
        ok: true,
        commandId: result.commandId,
        commandType: result.commandType,
        executedAt: result.executedAt,
        data: (result.data ?? null) as Record<string, unknown> | null,
      })
    },
  }

  const workspaceStatus: McpToolRegistration = {
    name: 'workspace.status',
    description: 'Read one workspace from the main process store, including its agents and their terminal liveness.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list or workspace.create.' },
      },
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
      'Create a workspace in the running Multicode instance. The main process owns the registry, so this ' +
      'succeeds with no window open and the returned workspace is immediately addressable by every other tool.',
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
      // Synchronous authority: the id comes back from the same call that
      // committed it, which is what retired the delegate-to-renderer round trip
      // and its 7s bus-confirmation poll.
      const outcome = backends.createWorkspace(
        {
          name: optionalString(args.name),
          folderPath: optionalString(args.folderPath),
          templateId: optionalString(args.templateId),
        },
        'gateway',
      )
      if (!outcome.ok) return failure(outcome.reason, outcome.message)
      return success({ workspace: workspaceProjection(outcome.result.workspace) })
    },
  }

  const agentLaunch: McpToolRegistration = {
    name: 'agent.launch',
    description:
      'Add a fully-configured agent to a workspace and start its CLI through the same renderer flow the UI uses. ' +
      'Optionally selects the model, permission preset and connector, and isolates the agent in a ' +
      'git worktree. Success is confirmed by the agent terminal session registering with the main process.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id.' },
        cli: {
          type: 'string',
          description:
            'Agent CLI plugin id; defaults to the last selected CLI. cli.runtime.list enumerates the ids this ' +
            'app actually holds — do not guess one.',
        },
        name: { type: 'string', description: 'Agent display name.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
        cliModel: {
          type: 'string',
          description:
            'Model id for CLIs that support model selection; forwarded verbatim (the app does not validate it ' +
            "against the CLI). cli.runtime.list reports each CLI's declared model ids and whether it accepts " +
            'ids outside that list.',
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "manual" or "auto" — the canonical names. "bypass" is refused on this ' +
            'surface, and so is its pre-MC-2210 spelling "bypass_all"; the other legacy spellings ' +
            '("default", "auto_workspace") are not accepted here at all.',
        },
        connectorId: {
          type: 'string',
          description:
            "Connector id from the installed connectors. Attaches the connector's single-server MCP and forces " +
            'worktree isolation (the connector .mcp.json never lands in the checkout), even without "worktree".',
        },
        worktree: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' },
            baseRef: {
              type: 'string',
              description:
                'The ref the new worktree branches from (a branch name from workspace.checkout, e.g. "main"). ' +
                "Defaults to the workspace checkout's HEAD.",
            },
          },
          additionalProperties: false,
          description:
            'Isolate the agent in a git worktree on an "agent/<name>" branch instead of the workspace checkout.',
        },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'prompt', 'cliModel', 'connectorId'])
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
        connectorId: optionalString(args.connectorId),
        worktreeRequested: options.worktreeRequested,
        worktreeName: options.worktreeName,
        worktreeBaseRef: options.worktreeBaseRef,
      })
      if (!('agentId' in launched)) return launched
      return success({
        agent: agentProjection(launched.workspace, launched.agentId),
        ...(launched.worktreePath ? { worktreePath: launched.worktreePath } : {}),
        ...(launched.worktreeBranch ? { worktreeBranch: launched.worktreeBranch } : {}),
      })
    },
  }

  // The checkout facts behind a remote launch's checkout · branch segments
  // (checkout-and-branch-on-remote-create). A read, on `workspace:read`, so a
  // paired Studio can show where a chat would run before asking for it; the
  // worktree itself is minted by `agent.launch` (workspace:operate), never
  // here — scopes stay a function of the tool's NAME (tailnet-scopes.ts).
  const workspaceCheckout: McpToolRegistration = {
    name: 'workspace.checkout',
    description:
      "Read a workspace's git checkout: whether its folder is a repository, the branch it is on, the trunk, " +
      "every local branch, and the worktrees the repository holds. Pair it with agent.launch's " +
      '"worktree.baseRef" to start an agent on a fresh worktree branched from one of the listed branches.',
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
      const checkout = await backends.readWorkspaceCheckout(resolved.root)
      return success({ workspaceId, ...checkout })
    },
  }

  // The answer to "what may I pass as a cli / model / effort?" (MC-2120).
  // Before this, `agent.launch.cliModel` was a blind string an agent could only
  // guess at from a tool description's example. Reports the CLI plugin registry as the app itself resolves it —
  // declared, not probed: it says what the registry HOLDS, never whether the
  // binary is installed on this machine (that probe spawns a login shell per
  // CLI and belongs to the app's own availability refresh).
  const cliRuntimeList: McpToolRegistration = {
    name: 'cli.runtime.list',
    description:
      'List the agent CLIs this app can launch, with the model ids and reasoning-effort levels each one ' +
      'declares. Read it before passing `cli`/`cliModel` to agent.launch — those are otherwise blind strings. Only rows with `agentSelectable: ' +
      'true` may be launched as agents (the CLI reports agent state via lifecycle hooks); ' +
      'a false row is registry-held for install/detect only and every launch door refuses it. A CLI whose ' +
      '`allowCustomModelId` is true accepts model ids outside its listed options (the list is a seed, not a ' +
      'closed set); a level outside `reasoningLevels` is refused by the CLI itself. This reports what the ' +
      'registry HOLDS, not what is installed on this machine — it never probes for binaries.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Report only this CLI plugin id. Unknown ids fail rather than returning an empty list.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['cli'])
      if (invalid) return invalid
      const wanted = optionalString(args.cli)
      const plugins = backends.listPlugins()
      if (wanted && !plugins.some((plugin) => plugin.manifest.id === wanted)) {
        return failure(
          'unknown_cli',
          `No agent CLI "${wanted}" is registered in this app. Call cli.runtime.list with no arguments for the ids it holds.`,
        )
      }
      const clis = plugins
        .filter((plugin) => !wanted || plugin.manifest.id === wanted)
        .map((plugin) => cliRuntimeProjection(plugin))
      return success({ clis })
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

  // The list a remote client reads before attaching to one (MC-2165). Its own
  // tool family, not part of `agent.*`, because the tailnet scopes gate the
  // terminal tier separately from the structured-command set: watching an
  // agent's screen is a different grant from reading its launch state.
  const terminalList: McpToolRegistration = {
    name: 'terminal.list',
    description:
      'List the terminal sessions open in this app: session id, agent name, CLI, working directory, ' +
      'workspace, whether the process is live or the session is paused, and the agent phase when the CLI ' +
      "reports one. Use the session id to attach to a session's live output. Reads the terminal runtime; " +
      'never writes.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Report only sessions in this workspace.' },
        kind: {
          type: 'string',
          enum: ['agent', 'terminal'],
          description: 'Report only agent sessions, or only plain shells. Omit for both.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['workspaceId', 'kind'])
      if (invalid) return invalid
      const kind = optionalString(args.kind)
      if (kind !== undefined && kind !== 'agent' && kind !== 'terminal') {
        return failure('invalid_kind', 'The "kind" filter accepts "agent" or "terminal".')
      }
      const workspaceId = optionalString(args.workspaceId)
      // The name lookup reads the sync snapshot ONCE for the whole answer. It
      // used to go through `findWorkspace` per session, and each of those took
      // a fresh snapshot — a whole-registry clone per row, every 30 seconds
      // per paired machine, which was the main-thread stall of 2026-09-05.
      const workspaceRows = new Map(
        backends.getWorkspaceSyncSnapshot().state.workspaces.map((workspace) => [workspace.id, workspace]),
      )
      // The project hue, resolved once per DISTINCT workspace rather than per
      // row: `readRepositoryIdentity` holds its answers behind a timed cache
      // and de-duplicates in flight, but a dozen rows in one project would
      // still be a dozen awaits on the 30-second poll each paired device runs.
      const projectHues = new Map<string, number | null>()
      const projectHueFor = async (
        workspace: { id: string; folderPath?: string | null } | undefined,
      ): Promise<number | null> => {
        if (!workspace) return null
        const cached = projectHues.get(workspace.id)
        if (cached !== undefined) return cached
        const folderPath = workspace.folderPath ?? null
        const repository = folderPath ? await backends.readRepositoryIdentity(folderPath) : null
        const key = projectColorKey({ folderPath, repository })
        const hue = key ? projectHue(key) : null
        projectHues.set(workspace.id, hue)
        return hue
      }
      const sessions = await Promise.all(
        backends
          .listTerminalSessions()
          .filter((session) => !workspaceId || session.workspaceId === workspaceId)
          .filter((session) => !kind || session.kind === kind)
          .map(async (session) => ({
            ...terminalSessionProjection(session),
            // The phone's thread row (multicode-mobile id 81) carries the same
            // second line the sidebar does: the workspace's display name, and the
            // checkout's branch and diff read through the sidebar's own summary
            // share (one read per checkout per hold window, at most four reads
            // in flight). Both are additive and null when unknown, so an older
            // phone reads the row as before and a newer one never guesses.
            workspaceName: (session.workspaceId ? workspaceRows.get(session.workspaceId)?.name : null) ?? null,
            git: await terminalGitSummary(session),
            // The project's hue as a whole degree on the OKLCH wheel, hashed
            // from the repository key (or the folder's name when there is no
            // remote) by shared/project-hue.ts. Sent rather than left to the
            // client to derive so a phone and this desktop cannot disagree
            // about a degree; null when the chat has no folder, which is not a
            // project and wears no colour.
            projectHue: await projectHueFor(session.workspaceId ? workspaceRows.get(session.workspaceId) : undefined),
            // When the chat is asleep until, or null. The phone's list needs it
            // for the same reason the sidebar does: a snoozed chat that still
            // claims to be running is the bug the desktop fixed on 2026-09-10,
            // and the wire kept it.
            snoozedUntil: (session.workspaceId ? workspaceRows.get(session.workspaceId)?.snoozedUntil : null) || null,
          })),
      )
      return success({ terminals: sessions })
    },
  }

  /**
   * The workspace a `terminal.create` names, by id or by display name.
   *
   * Name resolution exists because the terminal tier is a scope tier of its own
   * (epic decision 4): a device paired for `terminal:control` alone may not call
   * `workspace.list`, so requiring an opaque id would make the terminal grant
   * unusable without a structured grant it was deliberately not given. A name
   * matching more than one workspace is an explicit refusal listing the ids —
   * picking the first would open a terminal in someone else's project.
   */
  function resolveTerminalWorkspace(args: Record<string, unknown>): { workspace: Workspace } | McpToolResult {
    const workspaceId = optionalString(args.workspaceId)?.trim()
    const workspaceName = optionalString(args.workspaceName)?.trim()
    if (workspaceId && workspaceName) {
      return failure('invalid_arguments', 'Name the workspace once: pass "workspaceId" or "workspaceName", not both.')
    }
    if (workspaceId) {
      const workspace = findWorkspace(workspaceId)
      return workspace
        ? { workspace }
        : failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    }
    if (!workspaceName) {
      return failure(
        'invalid_arguments',
        'Name the workspace to open the terminal in: pass "workspaceId" or "workspaceName".',
      )
    }
    const wanted = workspaceName.toLowerCase()
    const matches = backends
      .getWorkspaceSyncSnapshot()
      .state.workspaces.filter((candidate) => candidate.name.trim().toLowerCase() === wanted)
    if (matches.length === 0) {
      return failure('unknown_workspace', `No workspace named "${workspaceName}" is open in the running app.`)
    }
    if (matches.length > 1) {
      return failure(
        'ambiguous_workspace_name',
        `${matches.length} workspaces are named "${workspaceName}". Name one by id instead: ${matches
          .map((candidate) => candidate.id)
          .join(', ')}.`,
      )
    }
    return { workspace: matches[0] }
  }

  // Open a terminal on THIS machine from wherever the call came from (MC-2166).
  //
  // `terminal.*` rather than `agent.launch` because of the scopes: the terminal
  // tier is granted separately from the structured-command families, and "open
  // me a terminal I can type into" is that tier's own verb — a device holding
  // `terminal:control` already has arbitrary shell on this host through the
  // attach socket, so letting it create the session it will type into adds no
  // authority. It deliberately does NOT carry `agent.launch`'s connector or
  // worktree options: those create git worktrees and write connector config
  // into the checkout, which are workspace mutations and stay behind
  // `workspace:operate`.
  //
  // The session id comes back so the caller can attach immediately — that
  // round trip (create → attach → type) is the whole point, and searching
  // terminal.list for "the one that just appeared" would be a guess.
  const terminalCreate: McpToolRegistration = {
    name: 'terminal.create',
    description:
      'Open a new agent terminal on the machine running this app and return its session id, ready to attach. ' +
      'Works with no window open: the session exists in the main process, and a window opened later shows it as ' +
      'a pane with its scrollback intact. Name the workspace by "workspaceId" or by "workspaceName". The CLI and ' +
      "permission preset default to this machine's own launch settings unless you name them; `bypass` is " +
      'refused here as everywhere on this surface. Use cli.runtime.list for the CLI ids this app holds.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Target workspace id, from workspace.list or terminal.list.' },
        workspaceName: {
          type: 'string',
          description:
            'Target workspace by display name instead of id (case-insensitive). Refused when more than one ' +
            'workspace carries the name.',
        },
        cli: {
          type: 'string',
          description:
            "Agent CLI plugin id; defaults to this machine's last-selected CLI. cli.runtime.list enumerates the " +
            'ids this app actually holds — do not guess one.',
        },
        name: { type: 'string', description: 'Agent display name; defaults to an unused name from the shared pool.' },
        prompt: { type: 'string', description: 'Startup prompt sent to the CLI after launch.' },
        cliModel: {
          type: 'string',
          description: 'Model id for CLIs that support model selection; forwarded verbatim to the CLI.',
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "manual" or "auto" — the canonical names. "bypass" is refused on this ' +
            'surface, and so is its pre-MC-2210 spelling "bypass_all"; the other legacy spellings ' +
            '("default", "auto_workspace") are not accepted here at all. ' +
            "Omit to take this machine's own spawn default.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, [
        'workspaceId',
        'workspaceName',
        'cli',
        'name',
        'prompt',
        'cliModel',
      ])
      if (invalid) return invalid

      const resolved = resolveTerminalWorkspace(args)
      if (!('workspace' in resolved)) return resolved

      const requestedPreset = validatePermissionPreset(args)
      if (requestedPreset !== undefined && typeof requestedPreset !== 'string') return requestedPreset

      // Resolved here rather than left to the launch service so the preset the
      // pty will run under is known before it exists. The machine's own default
      // is honoured — that is what "uses this machine's launch settings" means —
      // except that `bypass` never crosses this surface: a caller that
      // inherited it would get an unsandboxed agent nobody on either end asked
      // for. Falling to the most restrictive preset is the surface's ceiling,
      // and the answer reports which preset actually applied.
      const machineDefault = backends.getAgentSpawnPermissionDefault()
      const permissionPreset =
        requestedPreset ??
        (machineDefault && machineDefault !== 'bypass' ? machineDefault : LAUNCH_PERMISSION_PRESETS[0])

      const launched = await launchConfiguredAgent({
        workspaceId: resolved.workspace.id,
        cli: optionalString(args.cli),
        name: optionalString(args.name),
        prompt: optionalString(args.prompt),
        cliModel: optionalString(args.cliModel),
        permissionPreset,
        worktreeRequested: false,
      })
      if (!('agentId' in launched)) return launched
      return success({
        sessionId: launched.session.sessionId,
        workspaceId: launched.workspace.id,
        agentId: launched.agentId,
        // What the launch RESOLVED, not what was asked for: the CLI came from
        // this machine's settings when the caller named none, and the preset may
        // have been clamped by the rule above.
        permissionPreset,
        terminal: terminalSessionProjection(launched.session),
      })
    },
  }

  // Backlog tools take no workspace id: the target project defaults to the
  // folder this agent connection was launched from, and external callers name
  // a folder directly.
  const PROJECT_ROOT_PROPERTY = {
    type: 'string',
    description:
      'Absolute path to the project folder. Optional — when omitted, the tool targets the project this agent ' +
      'connection was launched from. Only needed when calling from outside a Studio-launched agent.',
  }

  const backlogList: McpToolRegistration = {
    name: 'backlog.list',
    description:
      "List the project's Backlog items and epics (title, display id, status, type, triage axes, epic " +
      'membership). Reads item files and frontmatter only — never writes. Archived items are omitted.',
    inputSchema: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PROPERTY },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const listed = await backends.listBacklogItems(resolved.root)
      if (!listed.ok) return failure('backlog_unavailable', listed.message)
      return success({ workspaceKey: listed.key, items: listed.items })
    },
  }

  const backlogRead: McpToolRegistration = {
    name: 'backlog.read',
    description:
      'Read one Backlog item: parsed frontmatter fields plus the markdown body. ' +
      'The path must be a project-relative markdown path under backlog/.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const read = await backends.readBacklogItem(resolved.root, path)
      if (!read.ok) return failure('backlog_read_failed', read.message)
      return success({ item: read.item, body: read.body })
    },
  }

  const automationList: McpToolRegistration = {
    name: 'automation.list',
    description:
      "List a workspace's Automations (the outbound trigger/action definitions in .sprintengine/automations). Read-only.",
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
    description: "One automation's run history, newest first (the store keeps the most recent 50). Read-only.",
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

  // module.* / marketplace.* (MC-2078). Read-only by decision: install,
  // uninstall, and enable/disable mutate trust, and belong to the item that
  // models that permission question — not to the surface that reports state.
  //
  // The registry answered from is the renderer's mirrored universe: main sees
  // only its own modules, so a main-derived list would silently omit every
  // renderer-only module (Backlog, Design, Git, Memory, Dev tools). It is
  // widened with third-party modules installed on disk that never reached the
  // renderer — an untrusted or tampered module loads nowhere, and "what is
  // installed" has to include it or the answer is wrong in the case that
  // matters most.
  async function collectModuleRecords(): Promise<
    { snapshot: ModuleRegistrySnapshot; records: ModuleRecord[]; thirdPartyUnavailable?: string } | McpToolResult
  > {
    const snapshot = backends.getModuleRegistrySnapshot()
    if (!snapshot) {
      return failure(
        'module_registry_unavailable',
        'The running app has not reported its module registry yet (no window has finished starting). ' +
          'Retry once the app window is up.',
      )
    }
    let installed: ThirdPartyModuleListResult | null = null
    let thirdPartyUnavailable: string | undefined
    try {
      installed = await backends.listInstalledThirdPartyModules()
    } catch (error) {
      // The bundled half of the answer is still exact; say what is missing
      // rather than pretending no third-party module is installed.
      thirdPartyUnavailable = error instanceof Error ? error.message : 'The installed module folder could not be read.'
    }
    const installedById = new Map((installed?.modules ?? []).map((module) => [module.manifest.id, module] as const))
    const records: ModuleRecord[] = snapshot.modules.map((entry) => {
      const view = installedById.get(entry.id)
      installedById.delete(entry.id)
      return {
        id: entry.id,
        source: entry.source,
        enabled: entry.enabled,
        manifest: entry.manifest,
        entry,
        report: registeredModuleReport(entry, view),
      }
    })
    for (const view of installedById.values()) {
      records.push({
        id: view.manifest.id,
        source: 'third-party',
        enabled: false,
        manifest: view.manifest,
        entry: null,
        report: installedOnlyModuleReport(view),
      })
    }
    return { snapshot, records, ...(thirdPartyUnavailable ? { thirdPartyUnavailable } : {}) }
  }

  const moduleList: McpToolRegistration = {
    name: 'module.list',
    description:
      'List the capability modules this app has, as the user sees them: bundled and third-party, each with its ' +
      'source, version, whether it is enabled, and why it is not when it is off. Modules that ship only in ' +
      'development builds are absent from a packaged build entirely — never reported as present-but-disabled. ' +
      'A third-party module that is installed but untrusted appears here (installed) even though it loads nowhere. ' +
      'Read-only: enabling, installing, and trusting are not on this surface.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['bundled', 'third-party'], description: 'Only modules from this source.' },
        enabled: { type: 'boolean', description: 'Only modules in this enablement state.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (args.source !== undefined && args.source !== 'bundled' && args.source !== 'third-party') {
        return failure('invalid_arguments', '"source" must be "bundled" or "third-party" when provided.')
      }
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        return failure('invalid_arguments', '"enabled" must be a boolean when provided.')
      }
      const collected = await collectModuleRecords()
      if ('content' in collected) return collected
      const modules = collected.records
        .filter((record) => args.source === undefined || record.source === args.source)
        .filter((record) => args.enabled === undefined || record.enabled === args.enabled)
        .map((record) => record.report)
      return success({
        channel: collected.snapshot.channel,
        capturedAt: new Date(collected.snapshot.capturedAt).toISOString(),
        modules,
        ...(collected.thirdPartyUnavailable ? { thirdPartyUnavailable: collected.thirdPartyUnavailable } : {}),
      })
    },
  }

  const moduleStatus: McpToolRegistration = {
    name: 'module.status',
    description:
      'Read one capability module: its manifest, the permissions it declares, the surfaces it contributes ' +
      '(workspace types, doors, settings sections, commands, …), the gateway tools it adds, and — when it is ' +
      'not active — why. A module that ships only in development builds reports module_not_in_build on a ' +
      'packaged build rather than appearing disabled.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Module id from module.list, e.g. "automations".' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = requireString(args, 'id')
      if (typeof id !== 'string') return id
      const collected = await collectModuleRecords()
      if ('content' in collected) return collected
      const record = collected.records.find((candidate) => candidate.id === id)
      if (!record) {
        if (BUNDLED_MODULE_IDS.includes(id)) {
          return failure(
            'module_not_in_build',
            isDevOnlyModule(id) && collected.snapshot.channel === 'production'
              ? `Module "${id}" ships only in development builds; this build does not contain it, so it is absent rather than disabled.`
              : `Module "${id}" is a known module id but is not part of this ${collected.snapshot.channel} build.`,
          )
        }
        return failure('unknown_module', `Module "${id}" is not installed in the running app.`)
      }
      const contributedTools = backends
        .listModuleContributedTools()
        .filter((tool) => tool.moduleId === id)
        .map((tool) => tool.toolName)
      return success({
        channel: collected.snapshot.channel,
        capturedAt: new Date(collected.snapshot.capturedAt).toISOString(),
        module: {
          ...record.report,
          manifest: record.manifest,
          permissions: record.manifest.permissions ?? [],
          dependsOn: record.manifest.dependsOn ?? [],
          surfaces: record.entry?.surfaces ?? null,
          contributedTools,
        },
        ...(collected.thirdPartyUnavailable ? { thirdPartyUnavailable: collected.thirdPartyUnavailable } : {}),
      })
    },
  }

  const marketplaceList: McpToolRegistration = {
    name: 'marketplace.list',
    description:
      'Browse the extension marketplace index the app itself reads (same registry client, cache, and ' +
      'bundled-first policy as the Plugins marketplace) — modules, MCP servers, skill packs, agent CLIs and ' +
      'automations. Filter by what an entry provides to get the module-first facet. Read-only: installing is ' +
      'a trust decision and is not on this surface. The result discloses where the index came from and ' +
      'whether it is a stale offline cache.',
    inputSchema: {
      type: 'object',
      properties: {
        provides: {
          type: 'string',
          enum: [...MARKETPLACE_COMPONENT_KINDS],
          description: 'Only entries that bundle this component kind; "module" is the module-first facet.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive match over name, summary, category, publisher, and tags.',
        },
        forceRefresh: { type: 'boolean', description: 'Re-fetch the index instead of answering from the cache.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['provides', 'query'])
      if (invalid) return invalid
      if (
        args.provides !== undefined &&
        !MARKETPLACE_COMPONENT_KINDS.includes(args.provides as MarketplaceComponentKind)
      ) {
        return failure('invalid_arguments', `"provides" must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.`)
      }
      if (args.forceRefresh !== undefined && typeof args.forceRefresh !== 'boolean') {
        return failure('invalid_arguments', '"forceRefresh" must be a boolean when provided.')
      }
      const read = await backends.readMarketplaceRegistry(
        args.forceRefresh === true ? { forceRefresh: true } : undefined,
      )
      if (!read.ok) {
        return failure('marketplace_unavailable', `${read.message} (registry ${read.registryUrl}, state ${read.state})`)
      }
      const provides = optionalString(args.provides) as MarketplaceComponentKind | undefined
      const query = optionalString(args.query)?.trim().toLowerCase()
      const all = read.marketplace.plugins
      const matched = all
        .filter((plugin) => provides === undefined || plugin.provides.includes(provides))
        .filter((plugin) => query === undefined || marketplaceEntryMatches(plugin, query))
      return success({
        registryUrl: read.registryUrl,
        state: read.state,
        source: read.source,
        stale: read.stale,
        fetchedAt: read.fetchedAt,
        ...(read.state === 'offline' ? { notice: read.message } : {}),
        total: all.length,
        matched: matched.length,
        plugins: matched.map(marketplaceEntryProjection),
      })
    },
  }

  const BACKLOG_TYPES = ['epic', 'feature', 'bug', 'mockup', 'spike'] as const
  const BACKLOG_STATUSES = ['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'] as const
  const BACKLOG_DIFFICULTIES = ['xs', 's', 'm', 'l', 'xl'] as const
  const BACKLOG_CRITICALITIES = ['low', 'normal', 'high', 'critical'] as const
  const BACKLOG_RISKS = ['low', 'normal', 'high'] as const

  const backlogUpdate: McpToolRegistration = {
    name: 'backlog.update',
    description:
      "Update one Backlog item's lifecycle or triage frontmatter: status, type, difficulty, criticality, risk, " +
      'epic membership, or (on an epic) the dependenciesPlanned ordering mark. Pass null to clear a field ' +
      '(status cannot be cleared). Only supplied fields change; ' +
      'the item body is never touched and a real change gets a server-owned precise updated timestamp. ' +
      'Fields apply in a fixed order (status, type, triage, epic, dependenciesPlanned) and the first ' +
      'invalid field stops the write — fields earlier in the order stay applied.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
        status: { type: 'string', enum: [...BACKLOG_STATUSES] },
        type: { type: ['string', 'null'], enum: [...BACKLOG_TYPES, null] },
        difficulty: { type: ['string', 'null'], enum: [...BACKLOG_DIFFICULTIES, null] },
        criticality: { type: ['string', 'null'], enum: [...BACKLOG_CRITICALITIES, null] },
        risk: { type: ['string', 'null'], enum: [...BACKLOG_RISKS, null] },
        epic: { type: ['string', 'null'], description: 'Epic slug, or null to remove the item from its epic.' },
        dependenciesPlanned: {
          type: 'boolean',
          description:
            'On an EPIC: the ordering pass over its children is finished — their dependsOn edges are authored, ' +
            'and no edges at all means deliberately parallel. Set it as the LAST act of planning an epic. ' +
            "Nothing recomputes it: editing the epic's membership is your cue to re-check it. " +
            'false removes the mark.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const fields = ['status', 'type', 'difficulty', 'criticality', 'risk', 'epic'] as const
      if (!fields.some((field) => field in args) && !('dependenciesPlanned' in args)) {
        return failure('invalid_arguments', 'Supply at least one field to update.')
      }
      for (const field of fields) {
        if (field in args && args[field] !== null && typeof args[field] !== 'string') {
          return failure('invalid_arguments', `"${field}" must be a string${field === 'status' ? '' : ' or null'}.`)
        }
      }
      // The one boolean field: an assertion of intent, so it is true or false —
      // never a string "true", which would read as an accidental write.
      if ('dependenciesPlanned' in args && typeof args.dependenciesPlanned !== 'boolean') {
        return failure('invalid_arguments', '"dependenciesPlanned" must be true or false.')
      }
      if (args.status === null) return failure('invalid_arguments', 'Status cannot be cleared, only changed.')
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved

      // Apply in a fixed order, stopping at the first failure; the services
      // validate vocabulary and report plain messages.
      // Values are passed through as-typed; the services own vocabulary
      // validation and return plain messages for anything invalid.
      const base = { workspaceRoot: resolved.root, relativePath: path }
      const writes: Array<() => Promise<BacklogMutationResult>> = []
      if (typeof args.status === 'string') {
        writes.push(() =>
          backends.backlogWrite.updateStatus({ ...base, status: args.status as BacklogItemStatusPayload }),
        )
      }
      if ('type' in args) {
        writes.push(() =>
          backends.backlogWrite.updateType({ ...base, type: (args.type ?? null) as BacklogTypePayload | null }),
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
          }),
        )
      }
      if ('epic' in args) {
        writes.push(() => backends.backlogWrite.updateEpic({ ...base, epic: (args.epic ?? null) as string | null }))
      }
      if ('dependenciesPlanned' in args) {
        writes.push(() =>
          backends.backlogWrite.updateDependenciesPlanned({
            ...base,
            dependenciesPlanned: args.dependenciesPlanned as boolean,
          }),
        )
      }
      for (const write of writes) {
        const written = await write()
        if (!written.ok) return failure('backlog_update_failed', written.message)
      }
      return success({ updated: { relativePath: path } })
    },
  }

  const backlogRepair: McpToolRegistration = {
    name: 'backlog.repair',
    description:
      'Repair one diagnosed Backlog integrity defect. This is deliberately narrow: replace embedded NUL bytes ' +
      'with the visible \\0 escape, or reallocate one side of a proven duplicate numeric id to the next free id. ' +
      'The operation refuses files that do not currently have the named defect.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Item path relative to the project root.' },
        issue: { type: 'string', enum: ['embedded_nul', 'duplicate_id'] },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path', 'issue'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const issue = requireString(args, 'issue')
      if (typeof issue !== 'string') return issue
      if (issue !== 'embedded_nul' && issue !== 'duplicate_id') {
        return failure('invalid_arguments', '"issue" must be one of: embedded_nul, duplicate_id.')
      }
      const resolved = resolveBacklogRoot(args, context)
      if (!('root' in resolved)) return resolved
      const repaired = await backends.backlogWrite.repairIntegrity({
        workspaceRoot: resolved.root,
        relativePath: path,
        issue,
      })
      if (!repaired.ok) return failure('backlog_repair_failed', repaired.message)
      return success({ repaired })
    },
  }

  const backlogAssign: McpToolRegistration = {
    name: 'backlog.assign',
    description:
      'Record which agent is working a Backlog item (the working-agent link shown in the Backlog panel). ' +
      'Idempotent — assigning again replaces the previous agent link. Never changes item status. ' +
      "The panel's file watcher observes backlog/ item files, so a bare assignment appears on the panel's " +
      'next refresh rather than instantly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        agentId: { type: 'string', description: 'Agent id within the workspace (see workspace.status).' },
        projectRoot: PROJECT_ROOT_PROPERTY,
      },
      required: ['path', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const agentId = requireString(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const resolved = resolveBacklogWorkspace(args, context)
      if (!('workspace' in resolved)) return resolved
      const { workspace } = resolved
      const agent = workspace.agents[agentId]
      if (!agent) return failure('unknown_agent', `Agent "${agentId}" is not known in workspace "${workspace.id}".`)

      const link = buildAgentBacklogLink({ workspaceId: workspace.id, agentId, agentName: agent.name || agentId })
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
      return renderSkillInvocationTemplate(template, {
        skillId: BACKLOG_SKILL_ID,
        skillName: 'Backlog',
        path: relativePath,
      })
    }
    return backlogLifecycleHandoffPrompt(relativePath)
  }

  const backlogWork: McpToolRegistration = {
    name: 'backlog.work',
    description:
      'Hand a Backlog item to a freshly launched agent in one call: launches a configured agent whose first input ' +
      'is the target CLI\'s Backlog skill invocation (e.g. "/backlog <path>" for Claude, a plain-language ' +
      'lifecycle block for CLIs without skill integration), then records the working-agent link. Never changes ' +
      'item status — the Backlog skill contract owns lifecycle, exactly like dragging the item onto a terminal. ' +
      'Refuses completed or archived items. Same launch fields as agent.launch (bypass refused), minus ' +
      'the connector.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Item path relative to the project root. Items live in the folder of the epic they belong to, or backlog/unfiled/ when they have none — e.g. "backlog/auth-revamp/2026-09-01-token-rotation.md".',
        },
        projectRoot: PROJECT_ROOT_PROPERTY,
        cli: {
          type: 'string',
          description:
            'Agent CLI plugin id; defaults to the last selected CLI. cli.runtime.list enumerates the registered ids.',
        },
        name: { type: 'string', description: 'Agent display name.' },
        cliModel: {
          type: 'string',
          description:
            "Model id for CLIs that support model selection; forwarded verbatim. cli.runtime.list reports each CLI's ids.",
        },
        permissionPreset: {
          type: 'string',
          enum: [...LAUNCH_PERMISSION_PRESETS],
          description:
            'CLI permission preset: "manual" or "auto" — the canonical names. "bypass" is refused on this ' +
            'surface, and so is its pre-MC-2210 spelling "bypass_all"; the other legacy spellings ' +
            '("default", "auto_workspace") are not accepted here at all.',
        },
        worktree: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Worktree/branch name; defaults to the agent name.' } },
          additionalProperties: false,
          description:
            'Isolate the agent in a git worktree on an "agent/<name>" branch instead of the workspace checkout.',
        },
        instructions: {
          type: 'string',
          description: 'Extra context appended after the skill invocation in the startup prompt.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const path = requireString(args, 'path')
      if (typeof path !== 'string') return path
      const invalid = firstInvalidOptionalString(args, ['cli', 'name', 'cliModel', 'instructions'])
      if (invalid) return invalid
      const options = resolveLaunchOptions(args)
      if ('content' in options) return options
      const resolved = resolveBacklogWorkspace(args, context)
      if (!('workspace' in resolved)) return resolved
      const workspaceId = resolved.workspace.id

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
          `Backlog item ${read.item.relativePath} is ${reason} and cannot be handed to an agent.`,
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
          ...(written.ok
            ? {}
            : { warning: `Agent launched but the working-agent link was not recorded: ${written.message}` }),
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
        'The Automations module is disabled or not loaded in this app session; enable it in Settings → Modules.',
      )
    }
    return frontDoor
  }

  const automationCreate: McpToolRegistration = {
    name: 'automation.create',
    description:
      'Create an Automation definition through the same validated pipeline the UI uses (provider/permission ' +
      'checks, schedule validation, workspace-root trust). The definition object carries name, trigger ' +
      '{kind, config}, action {kind, config}, and an optional status. An agent-backed action must name ' +
      'permissionPreset "auto": naming none runs the agent unattended on "bypass", which is refused on ' +
      'this surface — that preset can only be set by a person in the app. "manual" is accepted but is ' +
      'rarely what you want here: an automation agent has nobody at its terminal, so it stops at the ' +
      'first approval prompt and hangs the run until the idle reaper fails it.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        definition: {
          type: 'object',
          description:
            'Automation definition draft: { name, trigger: { kind, config }, action: { kind, config }, ' +
            'status? }. See automation.list output for the shape of existing definitions.',
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
      const preset = resolvedActionPermissionPreset(args.definition)
      // Normalized before the compare, exactly as validatePermissionPreset does
      // above and for the same reason: a definition naming the pre-MC-2210
      // `bypass_all` cleared this ceiling on the raw string and was then
      // normalized to `bypass` downstream (parseSpawnAgentConfig), which is the
      // unattended self-escalation the ceiling exists to prevent
      // (backlog/2026-09-06-automation-create-misses-the-legacy-bypass-spelling.md).
      // A value outside the vocabulary normalizes to `manual`, which the create
      // pipeline then rejects on its own terms.
      if (preset !== null && normalizeCliPermissionPreset(preset as CliPermissionPreset) === 'bypass') {
        return failure(
          'permission_preset_not_allowed',
          'Automations created over the automation surface may not run on permissionPreset "bypass", which is ' +
            'what an agent-backed automation runs on when it names no preset — name "auto" explicitly. ' +
            'A person can set that preset in the Automations panel if it is genuinely needed.',
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
      'Run an existing schedule-triggered Automation now (the same "Run now" the panel offers). The run record ' +
      'is confirmed in the store before success. Agent-backed actions launch in the main process, so the run ' +
      'works with no app window open.',
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

  return [
    workspaceCheckout,
    workspaceCreate,
    workspaceList,
    workspaceMobileCommand,
    workspaceSnapshot,
    workspaceStatus,
    agentLaunch,
    agentStatus,
    cliRuntimeList,
    terminalList,
    terminalCreate,
    backlogList,
    backlogRead,
    backlogUpdate,
    backlogRepair,
    backlogAssign,
    backlogWork,
    automationList,
    automationRuns,
    moduleList,
    moduleStatus,
    marketplaceList,
    automationCreate,
    automationRun,
  ]
}

// One terminal session as terminal.list reports it (MC-2165): enough to choose
// one and label the stream, and nothing about its contents — the scrollback
// arrives over the attach socket, behind the same terminal scope, not here.
//
// `processAlive` and `suspended` are separate on purpose: a paused agent is not
// running (its pty was killed to reclaim memory) but is not gone either, and a
// client that collapsed the two would offer to type into a frozen screen.
/**
 * The checkout a terminal works in, summarised the way the sidebar row is:
 * branch, `+n −n`, and the scope that says whose changes they are (`worktree` —
 * this chat's own; `branch` — the branch's, possibly shared; `folder` — only
 * what is uncommitted). Null when the session has no directory or the read
 * fails; never a confident zero for a span that was not measured.
 */
async function terminalGitSummary(session: TerminalSessionSnapshot): Promise<{
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  scope: string
} | null> {
  // Only a running session is asked about — the sidebar's own rule (owner
  // ruling 2026-09-04, the-diff-an-agent-made decision 9): a parked or exited
  // chat's numbers would be the checkout's present state, not anything the
  // chat did. It is also what keeps a network read from fanning git out to
  // every checkout the runtime has ever held a session in.
  if (!session.processAlive) return null
  const checkoutPath = session.worktreePath ?? session.cwd
  if (!checkoutPath) return null
  try {
    const summary = await getWorkspaceChangeSummary({ checkoutPath })
    return {
      branch: summary.branch,
      additions: summary.additions,
      deletions: summary.deletions,
      changedFiles: summary.changedFiles,
      scope: summary.scope,
    }
  } catch {
    return null
  }
}

function terminalSessionProjection(session: TerminalSessionSnapshot): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    kind: session.kind,
    workspaceId: session.workspaceId ?? null,
    agentId: session.agentId ?? null,
    agentName: session.agentName ?? null,
    cli: session.cli ?? null,
    cwd: session.cwd ?? null,
    worktreePath: session.worktreePath ?? null,
    processAlive: session.processAlive,
    suspended: session.suspended,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    activity: session.activity.kind,
    // The agent's phase, marked with its provenance so a caller can tell an
    // authoritative hook frame from a lifecycle stamp (`starting` at spawn,
    // `stalled`/`exited`/`failed` from the watchdog and pty). Never an
    // output-timing guess. Absent for plain shells.
    agentState: session.agentState
      ? { phase: session.agentState.phase, source: session.agentState.source, since: session.agentState.since }
      : null,
    // ── What a remote row needs to say the same thing the sidebar says ──────
    //
    // Every field below is additive and null/zero when unknown, so a client
    // built before them reads the row exactly as it did. They exist because
    // the phone's thread list was already written against the first of them
    // and never received it: `readTerminalRow` in the mobile repo has read
    // `lastTurnEndedAt` since its thread-row epic, and this projection has
    // never sent it — so "finished while you were away" could not fire. The
    // rest are the facts the desktop's own row draws and the wire dropped.

    // When the agent's last turn ended. Distinct from `activity`, which the
    // reaper's suspend and the quit path overwrite with the moment the PROCESS
    // died — so a parked chat can still say when it actually finished.
    lastTurnEndedAt: session.lastTurnEndedAt ?? null,
    // Context-window usage from the session's own status line, or null: a plain
    // terminal, a CLI with no status line, or a session that has not made an
    // API call yet. Never a guess, and a /compact does not clear it.
    contextUsage: session.contextUsage
      ? { usedPercentage: session.contextUsage.usedPercentage, at: session.contextUsage.at }
      : null,
    // Subagents started and not yet seen to stop, so a row can say "3 running"
    // rather than a bare spinner. Zero for plain terminals and hookless CLIs.
    activeSubagents: session.activeSubagents ?? 0,
    // The pull requests this conversation has, newest first — the ones on its
    // observed branch and the ones it opened itself in any repository. Absent
    // on the snapshot means "not asked yet", which is not "none": an empty
    // array is sent only when main actually holds an empty list.
    pullRequests: (session.pullRequests ?? []).map((pr) => ({
      url: pr.url,
      repoKey: pr.repoKey,
      repoName: pr.repoName,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
    })),
  }
}

// One agent CLI as cli.runtime.list reports it (MC-2120). Everything here is
// manifest-declared, so the projection is honest about its own limits: an empty
// `models` means the CLI declares no seed list, which — with
// `allowCustomModelId` — is different from "no model may be passed".
function cliRuntimeProjection(plugin: LoadedPlugin): Record<string, unknown> {
  const { manifest } = plugin
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    source: plugin.source,
    binary: manifest.binary,
    // Hooks-only selectability (decision of record 2026-08-31): declared, not
    // probed — true exactly when the manifest carries an agentStateSpec. Rows
    // are marked rather than omitted so a remote caller holding a stale id
    // learns WHY it is refused instead of seeing the CLI vanish.
    agentSelectable: Boolean(manifest.agentStateSpec),
    supportsModelSelection: Boolean(manifest.modelSelection),
    models: (manifest.modelSelection?.options ?? []).map((option) => ({
      id: option.id,
      ...(option.label ? { label: option.label } : {}),
    })),
    allowCustomModelId: manifest.modelSelection?.allowCustomId === true,
    reasoningLevels: (manifest.reasoningSelection?.levels ?? []).map((level) => ({
      id: level.id,
      ...(level.label ? { label: level.label } : {}),
    })),
    defaultReasoningLevel: manifest.reasoningSelection?.default ?? null,
    permissionPresets: Object.keys(manifest.permissionPresets ?? {}),
  }
}

// One module as the module.* tools report it. `entry` is the renderer registry
// entry when the module reached the renderer at all; a third-party module that
// is installed but untrusted has none, which is exactly what its report says.
type ModuleRecord = {
  id: string
  source: 'bundled' | 'third-party'
  enabled: boolean
  /** The registered manifest, from the renderer registry or (for a module that
   *  never loaded) the installed folder main read it from. Never null: a module
   *  in this list described itself somewhere, and the declared permissions of an
   *  untrusted module are exactly what a caller needs before trusting it. */
  manifest: CapabilityManifest
  entry: ModuleRegistryEntry | null
  report: Record<string, unknown>
}

function registeredModuleReport(
  entry: ModuleRegistryEntry,
  view: ThirdPartyModuleView | undefined,
): Record<string, unknown> {
  return {
    id: entry.id,
    displayName: entry.manifest.displayName,
    version: entry.manifest.version,
    source: entry.source,
    publisher: entry.manifest.publisher ?? null,
    category: entry.manifest.category ?? null,
    summary: entry.manifest.summary ?? null,
    core: entry.manifest.core === true,
    installed: true,
    enabled: entry.enabled,
    absence: entry.absence,
    ...(view ? { trust: view.trust, launch: thirdPartyLaunchReport(view) } : {}),
  }
}

// Installed on disk, absent from the renderer registry: the module never
// loaded, so everything reported about it comes from main's own trust and
// launch classification.
function installedOnlyModuleReport(view: ThirdPartyModuleView): Record<string, unknown> {
  const id = view.manifest.id
  const absence =
    view.trust === 'invalid'
      ? { reason: 'invalid_signature', message: `Module "${id}" has an invalid signature and will not load.` }
      : view.trust === 'trusted'
        ? {
            reason: 'not_loaded',
            message:
              view.launch.message ??
              `Module "${id}" is installed and trusted but registered nothing in the running app.`,
          }
        : { reason: 'untrusted', message: `Module "${id}" is installed but not trusted yet (Settings → Modules).` }
  return {
    id,
    displayName: view.manifest.displayName,
    version: view.manifest.version,
    source: 'third-party',
    publisher: view.manifest.publisher ?? null,
    category: view.manifest.category ?? null,
    summary: view.manifest.summary ?? null,
    core: false,
    installed: true,
    enabled: false,
    absence,
    trust: view.trust,
    launch: thirdPartyLaunchReport(view),
  }
}

function thirdPartyLaunchReport(view: ThirdPartyModuleView): Record<string, unknown> {
  return {
    status: view.launch.status,
    hasMainEntry: view.launch.hasMainEntry,
    expectedToLoad: view.launch.expectedToLoad,
    ...(view.launch.message ? { message: view.launch.message } : {}),
    ...(view.launch.rendererEntry ? { rendererEntry: view.launch.rendererEntry.availability } : {}),
  }
}

// Mirrors the storefront's own filter (name, category, summary, publisher, the
// widened categories/tags facets) so an agent searching the marketplace matches
// what a person searching the Plugins marketplace would.
function marketplaceEntryMatches(plugin: MarketplacePluginEntry, needle: string): boolean {
  return [
    plugin.name,
    plugin.id,
    plugin.category,
    plugin.summary,
    plugin.publisher.name,
    ...(plugin.categories ?? []),
    ...(plugin.tags ?? []),
  ].some((field) => field.toLowerCase().includes(needle))
}

function marketplaceEntryProjection(plugin: MarketplacePluginEntry): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    publisher: { name: plugin.publisher.name, verified: plugin.publisher.verified },
    summary: plugin.summary,
    category: plugin.category,
    ...(plugin.categories ? { categories: plugin.categories } : {}),
    ...(plugin.tags ? { tags: plugin.tags } : {}),
    latest: plugin.latest,
    provides: plugin.provides,
    // The index is display metadata: permissions and changelog live in the
    // signed plugin.json that is only downloaded at install time, so they are
    // deliberately absent rather than guessed.
    signed: Boolean(plugin.signature),
    ...(plugin.source ? { bundleSource: plugin.source } : {}),
  }
}

// The definition draft's action config is opaque at this layer; the preset key
// is the one security-relevant field the tool inspects before handing the draft
// to the validated pipeline. It resolves the preset the way the run itself does
// (parseSpawnAgentConfig): an agent-backed action that names no preset runs on
// AUTOMATION_DEFAULT_PERMISSION_PRESET, so reading only the literal key would let
// an external caller reach bypass by omission. Non-agent actions launch no CLI
// and have no preset to resolve.
function resolvedActionPermissionPreset(definition: object): string | null {
  const action = (definition as { action?: unknown }).action
  if (typeof action !== 'object' || action === null) return null
  const kind = (action as { kind?: unknown }).kind
  const agentBacked = typeof kind === 'string' && AGENT_BACKED_ACTION_KINDS.includes(kind)
  const config = (action as { config?: unknown }).config
  const preset =
    typeof config === 'object' && config !== null
      ? (config as { permissionPreset?: unknown }).permissionPreset
      : undefined
  if (typeof preset === 'string') return preset
  return agentBacked ? AUTOMATION_DEFAULT_PERMISSION_PRESET : null
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
