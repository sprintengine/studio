import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { ActionContext, AutomationActionProvider, AutomationCliPermissionPreset, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { join } from 'node:path'

import type { Workspace, WorkspaceMode } from '../../renderer/src/types/workspace'
import { appendWorktreeGitExcludes, createGitWorktree, removeGitWorktree } from '../git'
import { RUN_SIGNAL_FILENAME } from './run-signal'
import { createWorkspaceConfirmed } from '../workspace-create'
import type { AutomationRunExecutionInput, AutomationRunExecutor } from './engine'
import { runSkillLoopAction } from './actions/run-skill-loop'
import { runSpawnAgentAction, type SpawnAgentResolvedTarget } from './actions/spawn-agent'
import {
  allowAutomationProvider,
  createBuiltInAutomationProviderRegistry,
  executableActionProviders,
  isFirstPartyAutomationProviderModule,
  type AutomationProviderPermissionChecker,
  type BuiltInAutomationProviderRegistryOptions,
  type RegisteredAutomationProvider,
} from './provider-registry'

export type LocalAutomationExecutorOptions = {
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  // Resolves the spawned agent's terminal-session executionId at launch-confirm
  // time so the run can correlate an agent-lifecycle exit back to itself. A miss
  // (or an absent resolver) leaves executionId undefined and never fails the
  // launch — the run falls back to the poll-scan. Wired by automations-module.
  resolveAgentExecutionId?: (input: { workspaceId: string; agentId: string }) => string | undefined
  isIntegrationAvailable?: (id: string) => boolean | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  launchConfirmTimeoutMs?: number
  launchConfirmPollIntervalMs?: number
  actionProviders?: AutomationActionProvider[]
  getActionProviders?: () => AutomationActionProvider[]
  actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[]
  getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission?: AutomationProviderPermissionChecker
  // Per-run worktree isolation for agent-backed runs. `createRunWorktree`
  // returns null when isolation is not possible (e.g. the folder is not a Git
  // repo) so the run falls back to the workspace checkout instead of blocking.
  createRunWorktree?: (input: { workspaceRoot: string; runId: string }) => Promise<RunWorktree | null>
  removeRunWorktree?: (input: { workspaceRoot: string; worktreePath: string }) => Promise<void>
}

export type RunWorktree = {
  worktreePath: string
  branch: string
}

export class AutomationActionBlockedError extends Error {
  constructor(readonly blockedReason: string) {
    super(blockedReason)
    this.name = 'AutomationActionBlockedError'
  }
}

const DEFAULT_LAUNCH_CONFIRM_TIMEOUT_MS = 20_000
const DEFAULT_LAUNCH_CONFIRM_POLL_INTERVAL_MS = 150

export function createLocalAutomationExecutor(options: LocalAutomationExecutorOptions): AutomationRunExecutor {
  const builtInRegistry = options.actionProviders
    || options.getActionProviders
    || options.actionProviderRegistrations
    || options.getActionProviderRegistrations
    ? null
    : createBuiltInAutomationProviderRegistry()
  const staticProviders = options.actionProviders ?? builtInRegistry?.listActionProviders() ?? createBuiltInAutomationActionProviders()
  const getActionProviders = options.getActionProviders ?? (() => staticProviders)
  const staticRegistrations = options.actionProviderRegistrations ?? builtInRegistry?.listActionProviderRegistrations()
  const getActionProviderRegistrations = options.getActionProviderRegistrations
    ?? (staticRegistrations ? () => staticRegistrations : undefined)
  const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
  return async (input) => {
    const registrations = getActionProviderRegistrations?.()
    const providers = registrations
      ? executableActionProviders(registrations, checkProviderPermission)
      : getActionProviders()
    return runLocalAutomationAction(input, providers, options, registrations)
  }
}

export function createBuiltInAutomationActionProviders(
  options?: BuiltInAutomationProviderRegistryOptions
): AutomationActionProvider[] {
  return createBuiltInAutomationProviderRegistry(options).listActionProviders()
}

export async function runLocalAutomationAction(
  input: AutomationRunExecutionInput,
  providers: AutomationActionProvider[],
  options: LocalAutomationExecutorOptions,
  registrations?: RegisteredAutomationProvider<AutomationActionProvider>[]
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
  const context = createActionContext(input, options, (patch) => {
    progress.push(patch)
  })

  try {
    const runtime = {
      definition: input.definition,
      runId: input.run.id,
      workspaceRoot: input.workspaceRoot,
      // Launch target precedence: an explicit config workspaceId (legacy/MCP
      // path) wins and launches into that named workspace; otherwise the default
      // automation route resolves-or-creates the per-project hidden
      // automations-host workspace for the run's folder. No standard workspace is
      // reused or created for the default route.
      resolveSpawnAgentTarget: (target: { workspaceId?: string; folderPath: string }) =>
        Promise.resolve(resolveLaunchTarget(target, options)),
      // Agent-backed runs launch into a per-run worktree so the agent's work
      // (and its PR) is isolated from the user's checkout. Isolation is
      // best-effort: a non-Git folder or a worktree failure falls back to the
      // workspace checkout rather than blocking the run. A definition can opt out
      // (runInWorktree === false) to run directly in the workspace checkout — that
      // run has no branch, so it cannot (and does not) open a PR. Absent ⇒ true,
      // so existing automations keep their per-run worktree.
      spawnAgent: async (spawnInput) => {
        // A connector run writes the connector's MCP config into the agent's cwd,
        // so it must land in an isolated worktree — never the user's checkout.
        // A connectorId therefore forces a worktree (overriding runInWorktree ===
        // false) and fails the launch rather than falling back to the workspace
        // checkout when one cannot be created, preserving the connector-chat
        // isolation invariant.
        const wantsWorktree = spawnInput.connectorId != null || input.definition.runInWorktree !== false
        const worktree = wantsWorktree ? await ensureRunWorktree(input, options) : null
        if (spawnInput.connectorId && !worktree) {
          throw new Error(
            `Connector automation run for "${spawnInput.connectorId}" requires an isolated worktree, `
            + 'but one could not be created (the folder is not a git repository or worktree creation failed).'
          )
        }
        const launched = await spawnAgent(
          { ...spawnInput, worktreePath: worktree?.worktreePath },
          options,
        )
        return { ...launched, worktreePath: worktree?.worktreePath, branch: worktree?.branch }
      },
      requireIntegration: context.requireIntegration,
    }

    const registration = registrations?.find((candidate) => candidate.kind === provider.kind)
    const firstPartyResolvedProvider = registration
      ? provider === registration.provider && isFirstPartyAutomationProviderModule(registration.moduleId)
      : false
    const providerResult = firstPartyResolvedProvider && provider.kind === 'spawn-agent'
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

export function createActionContext(
  input: AutomationRunExecutionInput,
  options: LocalAutomationExecutorOptions,
  reportProgress: (patch: Partial<AutomationRun>) => void
): ActionContext {
  return {
    automationId: input.definition.id,
    runId: input.run.id,
    workspaceRoot: input.workspaceRoot,
    triggerPayload: input.triggerPayload,
    spawnAgent: (spawnInput) => spawnAgent(spawnInput, options),
    runCommand: async () => {
      throw new AutomationActionBlockedError('run-command is deferred from Phase 1 and is not available as a built-in action.')
    },
    reportProgress,
    requireIntegration: (id) => {
      const available = options.isIntegrationAvailable?.(id)
      if (available !== true) throw new AutomationActionBlockedError(`Required integration is unavailable or unverified: ${id}`)
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
    specialistId?: string
    worktreePath?: string
    name?: string
    prompt: string
    connectorId?: string
    resolvedTarget?: SpawnAgentResolvedTarget
  },
  options: LocalAutomationExecutorOptions
): Promise<{ workspaceId: string; agentId: string; executionId?: string }> {
  const target = input.resolvedTarget ?? resolveLaunchTarget(input, options)
  const workspaceId = target.workspaceId ?? await createWorkspace({
    folderPath: target.folderPath,
    name: input.name,
  }, options)

  const delegated = await options.delegateToRenderer({
    kind: 'agent.launch',
    workspaceId,
    cli: input.cli,
    cliModel: input.cliModel,
    permissionPreset: input.permissionPreset,
    specialistId: input.specialistId,
    worktreePath: input.worktreePath,
    connectorId: input.connectorId,
    name: input.name,
    prompt: input.prompt,
  })
  if (!delegated.ok) throw new Error(delegated.message)
  if (!delegated.agentId) throw new Error('The renderer accepted the launch but returned no agent id.')
  if (delegated.workspaceId !== workspaceId) {
    throw new Error(`The renderer launched the agent in workspace "${delegated.workspaceId}" instead of "${workspaceId}".`)
  }

  const confirmed = await waitFor(
    options.launchConfirmTimeoutMs ?? DEFAULT_LAUNCH_CONFIRM_TIMEOUT_MS,
    options.launchConfirmPollIntervalMs ?? DEFAULT_LAUNCH_CONFIRM_POLL_INTERVAL_MS,
    options,
    () => {
      const candidate = findWorkspaceById(options.getWorkspaceSyncSnapshot(), workspaceId)
      return candidate?.agents[delegated.agentId ?? ''] ? delegated.agentId ?? null : null
    }
  )
  if (!confirmed) {
    throw new Error(
      `Agent "${delegated.agentId}" was delegated to workspace "${workspaceId}" but was not observed on the workspace-sync bus.`
    )
  }

  // Correlation key for agent-lifecycle finalization. Best-effort: a miss leaves
  // executionId undefined and must not fail the launch — the run is then covered
  // by the per-tick signal poll-scan instead of the exit trigger.
  const executionId = options.resolveAgentExecutionId?.({ workspaceId, agentId: confirmed })

  return { workspaceId, agentId: confirmed, executionId }
}

async function ensureRunWorktree(
  input: AutomationRunExecutionInput,
  options: LocalAutomationExecutorOptions
): Promise<RunWorktree | null> {
  const creator = options.createRunWorktree ?? defaultCreateRunWorktree
  try {
    return await creator({ workspaceRoot: input.workspaceRoot, runId: input.run.id })
  } catch {
    // Worktree isolation is best-effort; fall back to the workspace checkout
    // rather than blocking the run.
    return null
  }
}

export async function defaultCreateRunWorktree(
  input: { workspaceRoot: string; runId: string },
  excludeSignalFile: (worktreePath: string) => Promise<void> = excludeRunSignalFromWorktree
): Promise<RunWorktree | null> {
  const branchName = `automations/${input.runId}`
  const created = await createGitWorktree({
    repoRoot: input.workspaceRoot,
    containerPath: join(input.workspaceRoot, '.multi-code', 'automations', 'worktrees'),
    destinationPath: input.runId,
    branchName,
    baseRef: 'HEAD',
  })
  if (!created.ok) return null
  // Best-effort: keep the agent's run-status signal file out of git so neither the
  // agent's `git add -A` nor the finalize backstop-commit stages it into the run's
  // PR. A failure here must not fail the run or change the returned worktree.
  try {
    await excludeSignalFile(created.data.path)
  } catch (error) {
    console.warn(
      `[automations] could not exclude run-status signal file in worktree ${created.data.path}:`,
      error
    )
  }
  return { worktreePath: created.data.path, branch: created.data.branch ?? branchName }
}

/**
 * Append {@link RUN_SIGNAL_FILENAME} to the worktree's git exclude file so the
 * signal file is never staged into the run's PR. Delegates to the shared
 * {@link appendWorktreeGitExcludes} helper (git-path resolved, idempotent).
 * Throws if git or the write fails.
 */
export async function excludeRunSignalFromWorktree(worktreePath: string): Promise<void> {
  await appendWorktreeGitExcludes(worktreePath, [RUN_SIGNAL_FILENAME])
}

export async function defaultRemoveRunWorktree(
  input: { workspaceRoot: string; worktreePath: string }
): Promise<void> {
  await removeGitWorktree({ repoRoot: input.workspaceRoot, path: input.worktreePath, force: true })
}

// An explicit config workspaceId (legacy/MCP) launches into that named standard
// workspace; the default automation route resolves-or-creates the per-project
// hidden automations-host workspace for the run's folder.
function resolveLaunchTarget(
  input: { workspaceId?: string; folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions
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
  options: LocalAutomationExecutorOptions
): SpawnAgentResolvedTarget {
  const host = findHostWorkspaceByFolder(options.getWorkspaceSyncSnapshot(), folderPath)
  return host
    ? { workspaceId: host.id, folderPath: host.folderPath?.trim() || folderPath }
    : { folderPath }
}

// Explicit config workspaceId (legacy/MCP): launch into that named standard
// workspace, or a folder-matched standard workspace when the named one is not a
// standard workspace. Only reached when a workspaceId is provided.
function resolveStandardLaunchTarget(
  workspaceId: string,
  folderPath: string,
  options: LocalAutomationExecutorOptions
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

async function createWorkspace(
  input: { folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions
): Promise<string> {
  const created = await createWorkspaceConfirmed(
    {
      name: input.name,
      folderPath: input.folderPath,
      mode: AUTOMATIONS_HOST_WORKSPACE_MODE,
    },
    {
      delegateToRenderer: options.delegateToRenderer,
      getWorkspaceSyncSnapshot: options.getWorkspaceSyncSnapshot,
      now: options.now,
      sleep: options.sleep,
    }
  )
  if (!created.ok) throw new Error(created.message)
  if (!isAutomationsHostWorkspace(created.workspace)) {
    throw new Error(
      `Created workspace "${created.workspaceId}" is a ${created.workspace.mode} workspace; `
      + 'automation agent launch requires an automations-host workspace.'
    )
  }
  return created.workspaceId
}

function findWorkspaceById(snapshot: WorkspaceSyncSnapshot, workspaceId: string): Workspace | null {
  return snapshot.state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
}

function findStandardWorkspaceByFolder(snapshot: WorkspaceSyncSnapshot, folderPath: string): Workspace | null {
  const key = normalizeFolderKey(folderPath)
  if (!key) return null
  return snapshot.state.workspaces.find((workspace) =>
    isStandardWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key
  ) ?? null
}

function findHostWorkspaceByFolder(snapshot: WorkspaceSyncSnapshot, folderPath: string): Workspace | null {
  const key = normalizeFolderKey(folderPath)
  if (!key) return null
  return snapshot.state.workspaces.find((workspace) =>
    isAutomationsHostWorkspace(workspace) && normalizeFolderKey(workspace.folderPath) === key
  ) ?? null
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

async function waitFor<T>(
  timeoutMs: number,
  pollIntervalMs: number,
  options: Pick<LocalAutomationExecutorOptions, 'now' | 'sleep'>,
  probe: () => T | null
): Promise<T | null> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found !== null) return found
    if (now() >= deadline) return null
    await sleep(pollIntervalMs)
  }
}
