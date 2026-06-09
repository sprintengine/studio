import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  BacklogItemLinkPayload,
  BacklogMutationResult,
  BacklogReadResult,
  SprintEngineProjectionReadResult,
} from '../../../shared/electron-api'
import type { DiagnosticLogInput } from '../types/workspace'
import type { SprintEngineState, Workspace, WorkspaceId } from '../types/workspace'
import { publishDiagnostic } from './diagnostics'
import { logPerfEvent } from './perfDiagnostics'
import { normalizeSprintEngineProjection } from './sprintengine'
import { sprintEngineStatePathForBacklogLink } from './sprintengineBacklogLinks'

export type SprintEngineProjectionRefreshCause = 'supervisor' | 'auto-run' | 'manual' | 'mutation'

export type SprintEngineProjectionRefreshResult =
  | { status: 'changed'; state: SprintEngineState }
  | { status: 'unchanged'; state: SprintEngineState | null }
  | { status: 'skipped'; reason: 'missing-context' }
  | { status: 'error'; message: string }

export type SprintEngineProjectionRefreshPorts = {
  readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>
  setSprintEngineState(workspaceId: WorkspaceId, state: SprintEngineState | null): void
  readBacklogObjectStore?(workspaceRoot: string): Promise<BacklogReadResult>
  addOrUpdateBacklogLink?(input: {
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }): Promise<BacklogMutationResult>
  publishDiagnostic?(input: DiagnosticLogInput): Promise<unknown> | unknown
  now?(): number
}

export function sprintEngineProjectionSignature(projection: unknown): string {
  return JSON.stringify(projection)
}

function defaultSprintEngineProjectionRefreshPorts(): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: (statePath) => window.api.readSprintEngineProjection(statePath),
    setSprintEngineState: (workspaceId, state) =>
      useWorkspaceStore.getState().setSprintEngineState(workspaceId, state),
    readBacklogObjectStore: (workspaceRoot) => window.api.readBacklogObjectStore(workspaceRoot),
    addOrUpdateBacklogLink: (input) => window.api.addOrUpdateBacklogLink(input),
    publishDiagnostic: (input) => publishDiagnostic(input),
  }
}

export async function refreshSprintEngineWorkspaceProjection(input: {
  workspace: Workspace
  signatures: Map<string, string>
  cause: SprintEngineProjectionRefreshCause
  force?: boolean
  ports?: SprintEngineProjectionRefreshPorts
}): Promise<SprintEngineProjectionRefreshResult> {
  const { workspace, signatures, cause, force = false } = input
  const ports = input.ports ?? defaultSprintEngineProjectionRefreshPorts()

  if (!workspace.sprintEngineContext?.statePath) {
    return { status: 'skipped', reason: 'missing-context' }
  }

  const startedAt = ports.now?.() ?? performance.now()
  try {
    const projectionResult = await ports.readSprintEngineProjection(workspace.sprintEngineContext.statePath)
    if (!projectionResult.ok) throw new Error(projectionResult.message)

    const signature = sprintEngineProjectionSignature(projectionResult.data)
    if (!force && signatures.get(workspace.id) === signature) {
      logPerfEvent('SprintEngineProjection', 'refresh', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cause,
        changed: false,
        elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
      })
      return { status: 'unchanged', state: workspace.sprintEngineState }
    }

    const parsedState = normalizeSprintEngineProjection(
      projectionResult.data,
      workspace.sprintEngineContext.teamSlug,
    )
    if (!parsedState) throw new Error('Sprint Engine projection was malformed.')

    signatures.set(workspace.id, signature)
    ports.setSprintEngineState(workspace.id, parsedState)
    await refreshBacklogSprintEngineRunLinks({
      workspace,
      state: parsedState,
      ports,
    })
    logPerfEvent('SprintEngineProjection', 'refresh', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      changed: true,
      elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
      taskCount: parsedState.tasks.length,
      artifactCount: parsedState.artifacts.length,
      source: parsedState.projection?.source ?? 'unavailable',
    })
    return { status: 'changed', state: parsedState }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint Engine projection refresh failed',
      message,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    logPerfEvent('SprintEngineProjection', 'refresh-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      message,
      elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
    })
    return { status: 'error', message }
  }
}

function normalizedPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function isCompletedSprintEngineRun(state: SprintEngineState): boolean {
  return state.tasks.length > 0 && state.tasks.every((task) => task.status === 'done')
}

async function refreshBacklogSprintEngineRunLinks(input: {
  workspace: Workspace
  state: SprintEngineState
  ports: SprintEngineProjectionRefreshPorts
}): Promise<void> {
  const { workspace, state, ports } = input
  if (!isCompletedSprintEngineRun(state)) return
  if (!workspace.folderPath || !workspace.sprintEngineContext?.statePath) return
  if (!ports.readBacklogObjectStore || !ports.addOrUpdateBacklogLink) return

  const storeResult = await ports.readBacklogObjectStore(workspace.folderPath)
  if (!storeResult.ok) {
    await ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Backlog link refresh failed',
      message: storeResult.message,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return
  }

  const targetStatePathKey = normalizedPathKey(workspace.sprintEngineContext.statePath)
  for (const record of storeResult.store.items) {
    for (const link of record.links ?? []) {
      if (link.type !== 'execution') continue
      const linkStatePath = sprintEngineStatePathForBacklogLink(workspace.folderPath, link)
      if (!linkStatePath || normalizedPathKey(linkStatePath) !== targetStatePathKey) continue
      if (link.status === 'completed' && record.status === 'completed') continue

      const result = await ports.addOrUpdateBacklogLink({
        workspaceRoot: workspace.folderPath,
        relativePath: record.source.relativePath,
        link: { ...link, status: 'completed' },
        status: record.status === 'archived' ? undefined : 'completed',
      })
      if (!result.ok) {
        await ports.publishDiagnostic?.({
          level: 'warning',
          source: 'sprintengine',
          title: 'Backlog link refresh failed',
          message: result.message,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        })
      }
    }
  }
}
