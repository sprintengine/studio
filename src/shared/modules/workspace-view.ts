import type { Workspace } from '../../renderer/src/types/workspace'

// The read-only workspace view served to capability modules — the one
// app-side declaration behind both process surfaces (RendererHost.getWorkspace
// and the main-side WorkspaceContextToken); the SDK mirrors it and the drift
// guard holds the mirror exact. Node-free and type-only over renderer types so
// both tsconfig projects can import it.
export type ModuleWorkspaceView = {
  id: string
  name: string
  /**
   * Absolute folder the workspace opened (the primary checkout); null for
   * folderless workspaces. Sprint-run worktree-backed workspaces do their
   * live work in a worktree under this folder — a live-runtime surface, not
   * this snapshot, is where that resolution belongs.
   */
  folderPath: string | null
  /** Workspace type id ('standard' or a module-registered type). */
  mode: string
}

// Post-restart, the main process rebuilds its sync state from the routing
// snapshot with placeholder workspaces until a renderer re-hydrates the bus.
// A placeholder that carries no folder path cannot be told apart from a real
// folderless workspace, so resolution reports it as not-yet-resolvable (null)
// rather than attesting `folderPath: null` as fact.
const ROUTING_PLACEHOLDER_TEMPLATE_ID = 'workspace-sync-routing-placeholder'

export type ModuleWorkspaceViewSource = Pick<Workspace, 'id' | 'name' | 'folderPath' | 'mode' | 'templateId'>

export function toModuleWorkspaceView(workspace: ModuleWorkspaceViewSource): ModuleWorkspaceView | null {
  if (workspace.templateId === ROUTING_PLACEHOLDER_TEMPLATE_ID && !workspace.folderPath) return null
  return {
    id: workspace.id,
    name: workspace.name,
    folderPath: workspace.folderPath ?? null,
    mode: workspace.mode,
  }
}
