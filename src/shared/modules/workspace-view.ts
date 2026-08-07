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

export type ModuleWorkspaceViewSource = Pick<Workspace, 'id' | 'name' | 'folderPath' | 'mode' | 'templateId'>

// Every record main holds is a real workspace now (MC-2158). The
// not-yet-resolvable branch this used to carry existed for restart-restored
// routing placeholders — records whose folder was unknown until a renderer
// re-offered them — and it went with the placeholder model: a `folderPath: null`
// here is now a fact about a genuinely folderless workspace, not an admission
// that main had not been told yet.
export function toModuleWorkspaceView(workspace: ModuleWorkspaceViewSource): ModuleWorkspaceView | null {
  return {
    id: workspace.id,
    name: workspace.name,
    folderPath: workspace.folderPath ?? null,
    mode: workspace.mode,
  }
}
