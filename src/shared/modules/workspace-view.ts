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
   * folderless workspaces. A worktree-backed workspace does its live work in
   * a worktree under this folder — a live-runtime surface, not this snapshot,
   * is where that resolution belongs.
   */
  folderPath: string | null
  /** Workspace type id ('standard' or a module-registered type). */
  mode: string
}

/**
 * One workspace as `WorkspaceContextService.list` reports it: the view, plus
 * whether it is open now. With `includeClosed`, workspaces closed on this
 * machine are listed after the open ones, newest first, as they were when
 * they closed; their folders may since have moved or gone.
 */
export type ModuleWorkspaceListEntry = ModuleWorkspaceView & {
  open: boolean
  /** When a closed workspace was closed (epoch ms); absent while it is open. */
  closedAt?: number
}

export type ModuleWorkspaceListOptions = {
  /** Also list the workspaces closed on this machine (the most recent 500). */
  includeClosed?: boolean
}

/** A git remote of a workspace's repository, as `git remote -v` names it (fetch URL). */
export type ModuleWorkspaceGitRemote = {
  name: string
  /** The fetch URL, with any credentials in it removed. */
  url: string
  /** `owner/repo` when the remote is a GitHub repository, SSH host aliases resolved. */
  github?: string
}

export type ModuleWorkspaceGitInfoErrorCode =
  'permission_missing' | 'unknown_workspace' | 'no_folder' | 'not_a_repository' | 'unavailable' | 'git_failed'

/**
 * A workspace's checked-out branch (null on a detached HEAD) and its remotes,
 * read by git from the workspace's own folder — so a worktree reports its own
 * branch and a submodule its own repository.
 */
export type ModuleWorkspaceGitInfoResult =
  | { ok: true; branch: string | null; remotes: ModuleWorkspaceGitRemote[] }
  | { ok: false; code: ModuleWorkspaceGitInfoErrorCode; message: string }

export type ModuleWorkspaceViewSource = Pick<Workspace, 'id' | 'name' | 'folderPath' | 'mode' | 'templateId'>

// Every record main holds is a real workspace now. The
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
