import { readAuxWindowBounds } from './auxWindowPlacement'

// Opens (or retargets the singleton) diff viewer window for a changed file.
// `scope` selects which diff to show first: `staged` is HEAD↔index, `unstaged`
// is index↔worktree. The viewer loads the full changed-file list itself so arrow
// navigation flows across files regardless of the entry point.
export async function openDiffWindow(input: {
  // The workspace whose pane the window docks back into ("Show in the app").
  // Carried as a param so the window — which has no workspace shell of its own
  // — can name the workspace when it hands the diff back.
  workspaceId?: string
  repoRoot: string
  focusPath: string
  scope: 'staged' | 'unstaged'
  // Show only this changelist's files. Absent = all changes (the behaviour
  // every caller had before agent changelists).
  changelistId?: string
}): Promise<void> {
  await window.api.openAuxWindow({
    kind: 'diff',
    // One diff window at a time — a constant key retargets the existing window.
    singletonKey: 'diff',
    params: {
      repoRoot: input.repoRoot,
      focusPath: input.focusPath,
      scope: input.scope,
      ...(input.changelistId ? { changelistId: input.changelistId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    bounds: readAuxWindowBounds('diff'),
  })
}
