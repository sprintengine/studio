import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { ActionContext, AutomationActionProvider, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { getGitRepoRoot, getGitStatus } from '../git'
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
  isIntegrationAvailable?: (id: string) => boolean | undefined
  isWorkspaceDirty?: (input: { workspaceId?: string; folderPath: string; workspace: Workspace | null }) => Promise<WorkspaceDirtyResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  launchConfirmTimeoutMs?: number
  launchConfirmPollIntervalMs?: number
  actionProviders?: AutomationActionProvider[]
  getActionProviders?: () => AutomationActionProvider[]
  actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[]
  getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[]
  checkProviderPermission?: AutomationProviderPermissionChecker
}

export type WorkspaceDirtyResult = {
  dirty: boolean
  reason?: string
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
      resolveSpawnAgentTarget: (target: { workspaceId?: string; folderPath: string }) =>
        Promise.resolve(resolveStandardLaunchTarget(target, options)),
      spawnAgent: context.spawnAgent,
      requireIntegration: context.requireIntegration,
      isWorkspaceDirty: async (target: SpawnAgentResolvedTarget) => {
        const workspace = target.workspaceId
          ? findWorkspaceById(options.getWorkspaceSyncSnapshot(), target.workspaceId)
          : null
        if (target.workspaceId && !workspace) {
          throw new AutomationActionBlockedError(`Unable to verify that target workspace "${target.workspaceId}" is clean because it is no longer known to the workspace-sync bus.`)
        }
        const resolvedFolderPath = workspace?.folderPath?.trim()
        if (target.workspaceId && workspace && !resolvedFolderPath) {
          throw new AutomationActionBlockedError(`Unable to verify that target workspace "${target.workspaceId}" is clean because it has no folder path.`)
        }
        const checker = options.isWorkspaceDirty ?? defaultWorkspaceDirtyCheck
        return checker({ ...target, folderPath: resolvedFolderPath || target.folderPath, workspace })
      },
    }

    const registration = registrations?.find((candidate) => candidate.kind === provider.kind)
    const firstPartyResolvedProvider = registration
      ? isFirstPartyAutomationProviderModule(registration.moduleId)
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
    name?: string
    prompt: string
    resolvedTarget?: SpawnAgentResolvedTarget
  },
  options: LocalAutomationExecutorOptions
): Promise<{ workspaceId: string; agentId: string }> {
  const target = input.resolvedTarget ?? resolveStandardLaunchTarget(input, options)
  const workspaceId = target.workspaceId ?? await createWorkspace({
    folderPath: target.folderPath,
    name: input.name,
  }, options)

  const delegated = await options.delegateToRenderer({
    kind: 'agent.launch',
    workspaceId,
    cli: input.cli,
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

  return { workspaceId, agentId: confirmed }
}

function resolveStandardLaunchTarget(
  input: { workspaceId?: string; folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions
): SpawnAgentResolvedTarget {
  const snapshot = options.getWorkspaceSyncSnapshot()
  if (input.workspaceId) {
    const explicitWorkspace = findWorkspaceById(snapshot, input.workspaceId)
    if (!explicitWorkspace) {
      throw new Error(`Workspace "${input.workspaceId}" is not known to the workspace-sync bus.`)
    }
    if (isStandardWorkspace(explicitWorkspace)) {
      return {
        workspaceId: explicitWorkspace.id,
        folderPath: explicitWorkspace.folderPath?.trim() || input.folderPath,
      }
    }

    const targetFolderPath = explicitWorkspace.folderPath?.trim() || input.folderPath
    const standardWorkspace = findStandardWorkspaceByFolder(snapshot, targetFolderPath)
    return standardWorkspace
      ? {
          workspaceId: standardWorkspace.id,
          folderPath: standardWorkspace.folderPath?.trim() || targetFolderPath,
        }
      : { folderPath: targetFolderPath }
  }

  const standardWorkspace = findStandardWorkspaceByFolder(snapshot, input.folderPath)
  return standardWorkspace
    ? {
        workspaceId: standardWorkspace.id,
        folderPath: standardWorkspace.folderPath?.trim() || input.folderPath,
      }
    : { folderPath: input.folderPath }
}

async function createWorkspace(
  input: { folderPath: string; name?: string },
  options: LocalAutomationExecutorOptions
): Promise<string> {
  const created = await createWorkspaceConfirmed(
    {
      name: input.name,
      folderPath: input.folderPath,
    },
    {
      delegateToRenderer: options.delegateToRenderer,
      getWorkspaceSyncSnapshot: options.getWorkspaceSyncSnapshot,
      now: options.now,
      sleep: options.sleep,
    }
  )
  if (!created.ok) throw new Error(created.message)
  if (!isStandardWorkspace(created.workspace)) {
    throw new Error(
      `Created workspace "${created.workspaceId}" is a ${created.workspace.mode} workspace; `
      + 'automation agent launch requires a standard workspace.'
    )
  }
  return created.workspaceId
}

export async function defaultWorkspaceDirtyCheck(input: {
  folderPath: string
  workspace: Workspace | null
}): Promise<WorkspaceDirtyResult> {
  if (input.workspace?.editorState.openFiles.some((file) => file.isDirty)) {
    return { dirty: true, reason: 'Target workspace has unsaved editor changes.' }
  }

  const repoRoot = await getGitRepoRoot(input.folderPath)
  if (!repoRoot) {
    return {
      dirty: true,
      reason: 'Unable to verify a clean automation baseline because the target folder is not inside a Git repository.',
    }
  }

  try {
    const status = await getGitStatus(repoRoot)
    const dirtyFiles = Object.keys(status.files)
    return dirtyFiles.length > 0
      ? { dirty: true, reason: `Target workspace has uncommitted Git changes (${dirtyFiles.length} file${dirtyFiles.length === 1 ? '' : 's'}).` }
      : { dirty: false }
  } catch (error) {
    return {
      dirty: true,
      reason: error instanceof Error
        ? `Unable to verify that the target workspace is clean: ${error.message}`
        : 'Unable to verify that the target workspace is clean.',
    }
  }
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

function isStandardWorkspace(workspace: Workspace): boolean {
  return workspace.mode === 'standard'
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
