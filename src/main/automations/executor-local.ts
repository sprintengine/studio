import type {
  ActionContext,
  AutomationActionProvider,
  AutomationCliPermissionPreset,
  AutomationRun,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'

import type { Workspace, WorkspaceMode } from '../../renderer/src/types/workspace'
import { createGitWorktree, removeGitWorktree } from '../git'
import { resolveRepoRoot } from '../git-worktree-validation'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../workspace-registry-service'
import type { WorkspaceMutationActor } from '../workspace-sync-service'
import type { AutomationConversationEndEvent, AutomationRunExecutionInput, AutomationRunExecutor } from './engine'
import { runSkillLoopAction } from './actions/run-skill-loop'
import { runSpawnAgentAction, type SpawnAgentResolvedTarget, type SpawnAgentRuntime } from './actions/spawn-agent'
import {
  allowAutomationProvider,
  createBuiltInAutomationProviderRegistry,
  executableActionProviders,
  isFirstPartyAutomationProviderModule,
  type AutomationProviderPermissionChecker,
  type RegisteredAutomationProvider,
} from './provider-registry'
import { workspaceSidecarPath } from '../workspace-sidecar'

export type LocalAutomationExecutorOptions = {
  /**
   * Start the run's agent as a chat conversation in main, and send it the run's
   * prompt. Every automation's agent is a chat (built-in actions and module
   * actions alike), so its run ends on the conversation's own turn events
   * rather than on anything a terminal reports. Every other outbound port here
   * is a main service too, so the executor asks a window for nothing.
   */
  launchConversation(request: ConversationLaunchRequest): Promise<ConversationLaunchResult>
  /**
   * Where a run's conversation that ended before its first turn is reported
   * (its first message was refused). Wired by automations-module to the
   * engine, which fails the run; absent, the run waits for the max-duration
   * sweep.
   */
  reportConversationEnd?: (event: AutomationConversationEndEvent) => void
  /**
   * Mint the run's automations-host workspace in main's registry.
   * The other half of headless: host creation used to be a renderer errand
   * too, and reuse of an existing host could only be guaranteed within one
   * window — main's single writer guarantees it across all of them.
   */
  createWorkspace(
    input: WorkspaceCreateRequest,
    actor: WorkspaceMutationActor,
  ): { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string }
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  isIntegrationAvailable?: (id: string) => boolean | undefined
  actionProviders?: AutomationActionProvider[]
  getActionProviders?: () => AutomationActionProvider[]
  actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[]
  getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission?: AutomationProviderPermissionChecker
  // Per-run worktree isolation for agent-backed runs. A run that asks for
  // isolation and cannot get it fails — the creator throws
  // RunWorktreeUnavailableError rather than reporting "no worktree", because
  // there is no acceptable answer below isolation for an unattended agent.
  createRunWorktree?: (input: { workspaceRoot: string; runId: string }) => Promise<RunWorktree>
  removeRunWorktree?: (input: { workspaceRoot: string; worktreePath: string }) => Promise<void>
}

export type RunWorktree = {
  worktreePath: string
  branch: string
}

class AutomationActionBlockedError extends Error {
  constructor(readonly blockedReason: string) {
    super(blockedReason)
    this.name = 'AutomationActionBlockedError'
  }
}

// Why the run got no worktree. A folder that is not a git repository can never
// produce one (the user has to answer that), while a worktree failure is
// situational — a stale branch, a locked worktree, a full disk — so the two must
// not read as the same blocked run.
export type RunWorktreeUnavailableReason = 'not_a_git_repository' | 'worktree_creation_failed'

export class RunWorktreeUnavailableError extends Error {
  constructor(
    readonly reason: RunWorktreeUnavailableReason,
    message: string,
  ) {
    super(message)
    this.name = 'RunWorktreeUnavailableError'
  }
}

export function createLocalAutomationExecutor(options: LocalAutomationExecutorOptions): AutomationRunExecutor {
  const builtInRegistry =
    options.actionProviders ||
    options.getActionProviders ||
    options.actionProviderRegistrations ||
    options.getActionProviderRegistrations
      ? null
      : createBuiltInAutomationProviderRegistry()
  const staticProviders =
    options.actionProviders ?? builtInRegistry?.listActionProviders() ?? createBuiltInAutomationActionProviders()
  const getActionProviders = options.getActionProviders ?? (() => staticProviders)
  const staticRegistrations = options.actionProviderRegistrations ?? builtInRegistry?.listActionProviderRegistrations()
  const getActionProviderRegistrations =
    options.getActionProviderRegistrations ?? (staticRegistrations ? () => staticRegistrations : undefined)
  const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
  return async (input) => {
    const registrations = getActionProviderRegistrations?.()
    const providers = registrations
      ? executableActionProviders(registrations, checkProviderPermission)
      : getActionProviders()
    return runLocalAutomationAction(input, providers, options, registrations)
  }
}

export function createBuiltInAutomationActionProviders(): AutomationActionProvider[] {
  return createBuiltInAutomationProviderRegistry().listActionProviders()
}

async function runLocalAutomationAction(
  input: AutomationRunExecutionInput,
  providers: AutomationActionProvider[],
  options: LocalAutomationExecutorOptions,
  registrations?: RegisteredAutomationProvider<AutomationActionProvider>[],
): Promise<Partial<AutomationRun>> {
  const provider = providers.find((candidate) => candidate.kind === input.definition.action.kind)
  if (!provider) {
    return {
      status: 'blocked',
      blockedReason: `No built-in automation action is registered for "${input.definition.action.kind}".`,
      summary: 'Automation action blocked before launch because no local provider is registered.',
    }
  }

  const progress: Partial<AutomationRun>[] = []
  const registration = registrations?.find((candidate) => candidate.kind === provider.kind)
  // A module's action starts a chat that module owns, so the module can follow
  // and drive it through its conversation service; a built-in action's chat is
  // the app's own.
  const context = createActionContext(input, options, registration?.moduleId, (patch) => {
    progress.push(patch)
  })

  try {
    const runtime: SpawnAgentRuntime = {
      definition: input.definition,
      runId: input.run.id,
      workspaceRoot: input.workspaceRoot,
      // Opt-in trigger context: spawn-agent/run-skill-loop surface this payload in
      // the launch prompt only when their config sets includeTriggerContext.
      triggerPayload: input.triggerPayload,
      // Launch target precedence: an explicit config workspaceId (legacy/MCP
      // path) wins and launches into that named workspace; otherwise the default
      // automation route resolves-or-creates the per-project hidden
      // automations-host workspace for the run's folder. No standard workspace is
      // reused or created for the default route.
      resolveSpawnAgentTarget: (target: { workspaceId?: string; folderPath: string }) =>
        Promise.resolve(resolveLaunchTarget(target, options)),
      // Agent-backed runs launch into a per-run worktree so the agent's work
      // (and its PR) is isolated from the user's checkout. Isolation is not
      // best-effort: a run that asks for a worktree and cannot get one is
      // blocked, never downgraded to the user's checkout — an unattended agent
      // runs with permissions bypassed, and a run with no worktree also has no
      // branch and so no pull request to review. A definition can opt out
      // (runInWorktree === false) to run directly in the workspace checkout, and
      // that opt-out is the user's to make. Absent ⇒ true, so existing
      // automations keep their per-run worktree.
      // A connector run's chat is started with that connector's MCP server; a
      // connector that is not installed, or a CLI whose chats take no server of
      // their own, fails the launch and so the run, never a run without it.
      spawnAgent: async (spawnInput) => {
        const worktree = input.definition.runInWorktree !== false ? await ensureRunWorktree(input, options) : null
        const launched = await spawnAgent({ ...spawnInput, worktreePath: worktree?.worktreePath }, options)
        return { ...launched, worktreePath: worktree?.worktreePath, branch: worktree?.branch }
      },
      requireIntegration: context.requireIntegration,
    }

    const firstPartyResolvedProvider = registration
      ? provider === registration.provider && isFirstPartyAutomationProviderModule(registration.moduleId)
      : false
    const providerResult =
      firstPartyResolvedProvider && provider.kind === 'spawn-agent'
        ? await runSpawnAgentAction(input.definition.action.config, runtime)
        : firstPartyResolvedProvider && provider.kind === 'run-skill-loop'
          ? await runSkillLoopAction(input.definition.action.config, runtime)
          : await provider.run(input.definition.action.config, context)

    return Object.assign({}, ...progress, providerResult)
  } catch (error) {
    if (error instanceof AutomationActionBlockedError) {
      return {
        status: 'blocked',
        blockedReason: error.blockedReason,
        summary: 'Automation action blocked before launch.',
      }
    }
    return {
      status: 'failed',
      summary: error instanceof Error ? error.message : 'Automation action failed.',
    }
  }
}

function createActionContext(
  input: AutomationRunExecutionInput,
  options: LocalAutomationExecutorOptions,
  ownerModuleId: string | undefined,
  reportProgress: (patch: Partial<AutomationRun>) => void,
): ActionContext {
  return {
    automationId: input.definition.id,
    runId: input.run.id,
    workspaceRoot: input.workspaceRoot,
    triggerPayload: input.triggerPayload,
    spawnAgent: ({ model, ...spawnInput }) =>
      spawnAgent({ ...spawnInput, ...(model ? { cliModel: model } : {}), ownerModuleId }, options),
    runCommand: async () => {
      throw new AutomationActionBlockedError(
        'run-command is deferred from Phase 1 and is not available as a built-in action.',
      )
    },
    reportProgress,
    requireIntegration: (id) => {
      const available = options.isIntegrationAvailable?.(id)
      if (available !== true)
        throw new AutomationActionBlockedError(`Required integration is unavailable or unverified: ${id}`)
    },
  }
}

async function spawnAgent(
  input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    cliModel?: string
    permissionPreset?: AutomationCliPermissionPreset
    worktreePath?: string
    name?: string
    prompt: string
    skills?: string[]
    connectorId?: string
    ownerModuleId?: string
    resolvedTarget?: SpawnAgentResolvedTarget
  },
  options: LocalAutomationExecutorOptions,
): Promise<{ workspaceId: string; agentId: string; sessionId: string }> {
  const target = input.resolvedTarget ?? resolveLaunchTarget(input, options)
  // The host is the durable per-project Automations workspace, so it carries the
  // stable surface name — never the launching run's agent name, which would brand
  // the shared host after whichever automation happened to create it.
  const workspaceId =
    target.workspaceId ??
    createWorkspace(
      {
        folderPath: target.folderPath,
        name: 'Automations',
      },
      options,
    )

  // The first message is sent as the session comes up, and the launch answers
  // before it lands. A refusal can therefore arrive before the launch has said
  // which chat it started, and is held until it has.
  let launchedChat: { workspaceId: string; agentId: string; sessionId: string } | null = null
  let refusedBeforeLaunchAnswered: string | null = null
  const reportRefusal = (message: string): void => {
    options.reportConversationEnd?.({ reason: 'first_send_failed', ...launchedChat, message })
  }
  const launched = await options.launchConversation({
    workspaceId,
    cli: input.cli,
    cliModel: input.cliModel,
    permissionPreset: input.permissionPreset,
    worktreePath: input.worktreePath,
    name: input.name,
    prompt: input.prompt,
    ...(input.skills?.length ? { skills: input.skills } : {}),
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    ...(input.ownerModuleId ? { ownerModuleId: input.ownerModuleId } : {}),
    onFirstSendFailed: (message) => {
      if (launchedChat) reportRefusal(message)
      else refusedBeforeLaunchAnswered = message
    },
  })
  if (!launched.ok) throw new Error(launched.message)
  if (launched.workspaceId !== workspaceId) {
    throw new Error(`The agent launched in workspace "${launched.workspaceId}" instead of "${workspaceId}".`)
  }
  launchedChat = { workspaceId, agentId: launched.agentId, sessionId: launched.sessionId }
  if (refusedBeforeLaunchAnswered !== null) reportRefusal(refusedBeforeLaunchAnswered)
  return launchedChat
}

// Fails the run rather than returning "no worktree": every caller asked for
// isolation, and there is nowhere else to put an unattended agent. The blocked
// reason names the cause so a run blocked for want of a git repository is not
// read as a run whose worktree creation failed.
async function ensureRunWorktree(
  input: AutomationRunExecutionInput,
  options: LocalAutomationExecutorOptions,
): Promise<RunWorktree> {
  const creator = options.createRunWorktree ?? defaultCreateRunWorktree
  try {
    const worktree = await creator({ workspaceRoot: input.workspaceRoot, runId: input.run.id })
    // A creator that resolves to nothing is the old swallowed failure wearing a
    // different shape. The types forbid it; this is the boundary that enforces
    // it, because an injected creator is the one input here that TypeScript does
    // not get to check at runtime.
    if (!worktree) throw new RunWorktreeUnavailableError('worktree_creation_failed', 'no worktree was returned')
    return worktree
  } catch (error) {
    const subject = 'This automation runs in its own git worktree'
    const cause =
      error instanceof RunWorktreeUnavailableError && error.reason === 'not_a_git_repository'
        ? `${input.workspaceRoot} is not a git repository`
        : `worktree creation failed: ${error instanceof Error ? error.message : 'unknown error'}`
    throw new AutomationActionBlockedError(
      `${subject}, but ${cause}. The run was blocked rather than launched in the workspace checkout.`,
    )
  }
}

export async function defaultCreateRunWorktree(input: { workspaceRoot: string; runId: string }): Promise<RunWorktree> {
  const branchName = `automations/${input.runId}`
  const created = await createGitWorktree({
    repoRoot: input.workspaceRoot,
    containerPath: workspaceSidecarPath(input.workspaceRoot, 'automations', 'worktrees'),
    destinationPath: input.runId,
    branchName,
    baseRef: 'HEAD',
  })
  if (created.ok) return { worktreePath: created.data.path, branch: created.data.branch ?? branchName }
  // createGitWorktree resolves the repo root first, so classify by re-running
  // that one check — only on the failure path, leaving the happy path at a
  // single git invocation.
  const repoRoot = await resolveRepoRoot(input.workspaceRoot)
  throw new RunWorktreeUnavailableError(
    repoRoot.ok ? 'worktree_creation_failed' : 'not_a_git_repository',
    created.message,
  )
}

export async function defaultRemoveRunWorktree(input: { workspaceRoot: string; worktreePath: string }): Promise<void> {
  await removeGitWorktree({ repoRoot: input.workspaceRoot, path: input.worktreePath, force: true })
}

// An explicit config workspaceId (legacy/MCP) launches into that named standard
// workspace; the default automation route resolves-or-creates the per-project
// hidden automations-host workspace for the run's folder.
function resolveLaunchTarget(
  input: { workspaceId?: string; folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions,
): SpawnAgentResolvedTarget {
  return input.workspaceId
    ? resolveStandardLaunchTarget(input.workspaceId, input.folderPath, options)
    : resolveHostLaunchTarget(input.folderPath, options)
}

// Resolve the per-project automations-host workspace for a folder. Returns the
// existing host's target when one is open, or a bare `{ folderPath }` so
// `createWorkspace` creates a fresh host — never a standard workspace.
function resolveHostLaunchTarget(
  folderPath: string,
  options: LocalAutomationExecutorOptions,
): SpawnAgentResolvedTarget {
  const host = findHostWorkspaceByFolder(options.getWorkspaceSyncSnapshot(), folderPath)
  return host ? { workspaceId: host.id, folderPath: host.folderPath?.trim() || folderPath } : { folderPath }
}

// Explicit config workspaceId (legacy/MCP): launch into that named standard
// workspace, or a folder-matched standard workspace when the named one is not a
// standard workspace. Only reached when a workspaceId is provided.
function resolveStandardLaunchTarget(
  workspaceId: string,
  folderPath: string,
  options: LocalAutomationExecutorOptions,
): SpawnAgentResolvedTarget {
  const snapshot = options.getWorkspaceSyncSnapshot()
  const explicitWorkspace = findWorkspaceById(snapshot, workspaceId)
  if (!explicitWorkspace) {
    throw new Error(`Workspace "${workspaceId}" is not known to the workspace-sync bus.`)
  }
  if (isStandardWorkspace(explicitWorkspace)) {
    return {
      workspaceId: explicitWorkspace.id,
      folderPath: explicitWorkspace.folderPath?.trim() || folderPath,
    }
  }

  const targetFolderPath = explicitWorkspace.folderPath?.trim() || folderPath
  const standardWorkspace = findStandardWorkspaceByFolder(snapshot, targetFolderPath)
  return standardWorkspace
    ? {
        workspaceId: standardWorkspace.id,
        folderPath: standardWorkspace.folderPath?.trim() || targetFolderPath,
      }
    : { folderPath: targetFolderPath }
}

function createWorkspace(
  input: { folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions,
): string {
  const created = options.createWorkspace(
    {
      name: input.name,
      folderPath: input.folderPath,
      mode: AUTOMATIONS_HOST_WORKSPACE_MODE,
    },
    'automation',
  )
  if (!created.ok) throw new Error(created.message)
  const workspace = created.result.workspace
  if (!isAutomationsHostWorkspace(workspace)) {
    throw new Error(
      `Created workspace "${workspace.id}" is a ${workspace.mode} workspace; ` +
        'automation agent launch requires an automations-host workspace.',
    )
  }
  return workspace.id
}

function findWorkspaceById(snapshot: WorkspaceSyncSnapshot, workspaceId: string): Workspace | null {
  return snapshot.state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
}

function findStandardWorkspaceByFolder(snapshot: WorkspaceSyncSnapshot, folderPath: string): Workspace | null {
  const key = normalizeFolderKey(folderPath)
  if (!key) return null
  return (
    snapshot.state.workspaces.find(
      (workspace) => isStandardWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key,
    ) ?? null
  )
}

function findHostWorkspaceByFolder(snapshot: WorkspaceSyncSnapshot, folderPath: string): Workspace | null {
  const key = normalizeFolderKey(folderPath)
  if (!key) return null
  return (
    snapshot.state.workspaces.find(
      (workspace) => isAutomationsHostWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key,
    ) ?? null
  )
}

function isStandardWorkspace(workspace: Workspace): boolean {
  return workspace.mode === 'standard'
}

// Mode literal mirrors AUTOMATIONS_HOST_WORKSPACE_MODE in the renderer's
// types/workspace.ts. Main and renderer are separate TS projects, so this file
// matches a literal here (as isStandardWorkspace does for 'standard') rather than
// value-importing across the project boundary.
const AUTOMATIONS_HOST_WORKSPACE_MODE: WorkspaceMode = 'automations-host'

function isAutomationsHostWorkspace(workspace: Workspace): boolean {
  return workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
}

function normalizeFolderKey(folderPath: string | null | undefined): string | null {
  const trimmed = folderPath?.trim()
  return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null
}
