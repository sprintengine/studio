import { toModuleWorkspaceView, type ModuleWorkspaceView } from '../../shared/modules/workspace-view'
import type { WorkspaceCreateRequest } from '../workspace-registry-service'
import type { WorkspaceSyncService } from '../workspace-sync-service'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'

// The workspace-creation service capability modules consume via the host
// service bridge (WorkspaceServiceToken).
//
// It used to delegate to the primary renderer and then poll the workspace-sync
// bus for up to 7s to confirm the id it had been handed. Both are gone:
// main owns the registry, so `createWorkspace` mints the record
// under its own single writer and the id is readable in the same tick. A module
// can now create a workspace with no window open, which the delegated path used
// to refuse outright.

type ModuleWorkspaceCreateInput = WorkspaceCreateRequest

type ModuleWorkspaceCreateResult = { ok: true; workspaceId: string } | { ok: false; code: string; message: string }

export type ModuleWorkspaceService = {
  create(input: ModuleWorkspaceCreateInput): Promise<ModuleWorkspaceCreateResult>
}

export type ModuleWorkspaceServiceBackends = {
  workspaceSync: Pick<WorkspaceSyncService, 'createWorkspace'>
}

export function createModuleWorkspaceService(backends: ModuleWorkspaceServiceBackends): ModuleWorkspaceService {
  return {
    async create(input): Promise<ModuleWorkspaceCreateResult> {
      const outcome = backends.workspaceSync.createWorkspace(input, 'module')
      if (!outcome.ok) return { ok: false, code: outcome.reason, message: outcome.message }
      return { ok: true, workspaceId: outcome.result.workspace.id }
    },
  }
}

// Read-only workspace context resolution (WorkspaceContextToken): the main-side
// twin of RendererHost.getWorkspace, backed by the same registry the create flow
// writes. Unknown ids resolve to null (not currently resolvable), never a throw.
// Restart survivors resolve fully now — there is no placeholder record left
// whose folder path has yet to re-hydrate.
export type ModuleWorkspaceContextService = {
  get(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every workspace currently open, in registry order. The main-side twin of
   * `RendererHost.listWorkspaces`, and the only way a module's `entry.main`
   * can answer "which project roots are open" — an MCP tool a module
   * contributes runs with no window and no renderer to ask.
   */
  list(): Promise<ModuleWorkspaceView[]>
}

export type ModuleWorkspaceContextBackends = {
  getWorkspaceSyncSnapshot: () => WorkspaceSyncSnapshot
}

export function createModuleWorkspaceContextService(
  backends: ModuleWorkspaceContextBackends,
): ModuleWorkspaceContextService {
  return {
    async get(workspaceId): Promise<ModuleWorkspaceView | null> {
      const workspace = backends.getWorkspaceSyncSnapshot().state.workspaces.find((entry) => entry.id === workspaceId)
      if (!workspace) return null
      return toModuleWorkspaceView(workspace)
    },
    async list(): Promise<ModuleWorkspaceView[]> {
      return backends
        .getWorkspaceSyncSnapshot()
        .state.workspaces.map((workspace) => toModuleWorkspaceView(workspace))
        .filter((view): view is ModuleWorkspaceView => view !== null)
    },
  }
}
