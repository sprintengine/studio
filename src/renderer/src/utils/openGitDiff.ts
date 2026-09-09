import { useWorkspaceStore } from '../store/workspaceStore'
import { openDiffWindow } from '../components/auxWindows/openDiffWindow'

export type OpenGitDiffInput = {
  /** The workspace the row was activated in: the pane the diff docks into. */
  workspaceId: string
  /**
   * The repository the row belongs to, as the CALLER knows it — the Git panel's
   * active scope, the File Explorer's status root. Never re-derived downstream:
   * a workspace mounted on one worktree can be showing another scope's rows,
   * and re-deriving from the workspace opened the diff on the wrong repository.
   */
  repoRoot: string
  focusPath: string
  /** Which side to open on: `staged` is HEAD↔index, `unstaged` index↔worktree. */
  scope: 'staged' | 'unstaged'
  /**
   * Show only one changelist's files (`agent:<agentId>` for an owned list).
   * Absent means "All changes", which is what every caller meant before agent
   * changelists existed and still means today — the filter is additive, never
   * a default the viewer invents for itself.
   */
  changelistId?: string
}

// Single routing point for "show me this file's diff". Honours the sticky
// `diffOpensInWindow` preference: on (the default) the diff opens or retargets
// the one standalone window; off, it opens the workspace pane's Diff tab, which is the
// same viewer in the app. Both entry points to a diff — the Git panel's rows
// and the File Explorer's "View Git diff" — come through here, so the two
// stopped disagreeing about where a diff belongs (the panel routed to the tab,
// the explorer to the window, with no setting between them).
export function openGitDiff(input: OpenGitDiffInput): void {
  const store = useWorkspaceStore.getState()
  if (store.diffOpensInWindow) {
    void openDiffWindow({
      workspaceId: input.workspaceId,
      repoRoot: input.repoRoot,
      focusPath: input.focusPath,
      scope: input.scope,
      ...(input.changelistId ? { changelistId: input.changelistId } : {}),
    })
    return
  }
  store.openPaneTab(input.workspaceId, {
    kind: 'diff',
    diff: {
      repoRoot: input.repoRoot,
      focusPath: input.focusPath,
      focusKind: input.scope,
      ...(input.changelistId ? { changelistId: input.changelistId } : {}),
    },
  })
}
