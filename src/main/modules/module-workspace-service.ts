import {
  createWorkspaceConfirmed,
  type WorkspaceCreateDeps,
  type WorkspaceCreateInput,
} from '../workspace-create'
import { toModuleWorkspaceView, type ModuleWorkspaceView } from '../../shared/modules/workspace-view'

// The workspace-creation service capability modules consume via the host
// service bridge (WorkspaceServiceToken). It is a thin adapter over the shared
// createWorkspaceConfirmed core (also used by the automation workspace.create
// tool): delegate to the renderer, confirm on the workspace-sync bus, and hand
// the module just the confirmed id (or an explicit failure).

export type ModuleWorkspaceCreateInput = WorkspaceCreateInput

export type ModuleWorkspaceCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; code: string; message: string }

export type ModuleWorkspaceService = {
  create(input: ModuleWorkspaceCreateInput): Promise<ModuleWorkspaceCreateResult>
}

export type ModuleWorkspaceServiceBackends = WorkspaceCreateDeps

export function createModuleWorkspaceService(
  backends: ModuleWorkspaceServiceBackends
): ModuleWorkspaceService {
  return {
    async create(input): Promise<ModuleWorkspaceCreateResult> {
      const outcome = await createWorkspaceConfirmed(input, backends)
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message }
      return { ok: true, workspaceId: outcome.workspaceId }
    },
  }
}

// Read-only workspace context resolution (WorkspaceContextToken): the main-side
// twin of RendererHost.getWorkspace, backed by the same workspace-sync snapshot
// the create flow confirms against. Unknown ids — and post-restart routing
// placeholders whose folder path hasn't re-hydrated yet — resolve to null
// (not currently resolvable), never a throw.
export type { ModuleWorkspaceView } from '../../shared/modules/workspace-view'

export type ModuleWorkspaceContextService = {
  get(workspaceId: string): Promise<ModuleWorkspaceView | null>
}

export type ModuleWorkspaceContextBackends = Pick<WorkspaceCreateDeps, 'getWorkspaceSyncSnapshot'>

export function createModuleWorkspaceContextService(
  backends: ModuleWorkspaceContextBackends
): ModuleWorkspaceContextService {
  return {
    async get(workspaceId): Promise<ModuleWorkspaceView | null> {
      const workspace = backends
        .getWorkspaceSyncSnapshot()
        .state.workspaces.find((entry) => entry.id === workspaceId)
      if (!workspace) return null
      return toModuleWorkspaceView(workspace)
    },
  }
}
