import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { ActionContext, AutomationActionProvider, AutomationRun } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { getGitRepoRoot, getGitStatus } from '../git'
import { createWorkspaceConfirmed } from '../workspace-create'
import type { AutomationRunExecutionInput, AutomationRunExecutor } from './engine'
import { createRunSkillLoopActionProvider, runSkillLoopAction } from './actions/run-skill-loop'
import { createSpawnAgentActionProvider, runSpawnAgentAction } from './actions/spawn-agent'

export type LocalAutomationExecutorOptions = {
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  isIntegrationAvailable?: (id: string) => boolean | undefined
  isWorkspaceDirty?: (input: { workspaceId?: string; folderPath: string; workspace: Workspace | null }) => Promise<WorkspaceDirtyResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  launchConfirmTimeoutMs?: number
  launchConfirmPollIntervalMs?: number
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
  const providers = createBuiltInAutomationActionProviders()
  return async (input) => runLocalAutomationAction(input, providers, options)
}

export function createBuiltInAutomationActionProviders(): AutomationActionProvider[] {
  return [
    createSpawnAgentActionProvider(),
    createRunSkillLoopActionProvider(),
  ]
}

export async function runLocalAutomationAction(
  input: AutomationRunExecutionInput,
  providers: AutomationActionProvider[],
  options: LocalAutomationExecutorOptions
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
      spawnAgent: context.spawnAgent,
      requireIntegration: context.requireIntegration,
      isWorkspaceDirty: async (target: { workspaceId?: string; folderPath: string }) => {
        const workspace = target.workspaceId ? findWorkspaceById(options.getWorkspaceSyncSnapshot(), target.workspaceId) : findWorkspaceByFolder(options.getWorkspaceSyncSnapshot(), target.folderPath)
        const checker = options.isWorkspaceDirty ?? defaultWorkspaceDirtyCheck
        return checker({ ...target, workspace })
      },
    }

    const providerResult = provider.kind === 'spawn-agent'
      ? await runSpawnAgentAction(input.definition.action.config, runtime)
      : provider.kind === 'run-skill-loop'
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
  },
  options: LocalAutomationExecutorOptions
): Promise<{ workspaceId: string; agentId: string }> {
  const workspace = input.workspaceId
    ? findWorkspaceById(options.getWorkspaceSyncSnapshot(), input.workspaceId)
    : findWorkspaceByFolder(options.getWorkspaceSyncSnapshot(), input.folderPath)
  if (input.workspaceId && !workspace) {
    throw new Error(`Workspace "${input.workspaceId}" is not known to the workspace-sync bus.`)
  }
  const workspaceId = workspace?.id ?? await createWorkspace(input, options)

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
  return created.workspaceId
}

async function defaultWorkspaceDirtyCheck(input: {
  folderPath: string
  workspace: Workspace | null
}): Promise<WorkspaceDirtyResult> {
  if (input.workspace?.editorState.openFiles.some((file) => file.isDirty)) {
    return { dirty: true, reason: 'Target workspace has unsaved editor changes.' }
  }

  const repoRoot = await getGitRepoRoot(input.folderPath)
  if (!repoRoot) return { dirty: false }

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

function findWorkspaceByFolder(snapshot: WorkspaceSyncSnapshot, folderPath: string): Workspace | null {
  const key = normalizeFolderKey(folderPath)
  if (!key) return null
  return snapshot.state.workspaces.find((workspace) => normalizeFolderKey(workspace.folderPath) === key) ?? null
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
