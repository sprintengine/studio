import {
  createWorkspaceConfirmed,
  type WorkspaceCreateDeps,
  type WorkspaceCreateInput,
} from '../workspace-create'

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
