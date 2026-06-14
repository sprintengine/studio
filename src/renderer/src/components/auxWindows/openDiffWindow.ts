import { readAuxWindowBounds } from './auxWindowPlacement'

// Opens (or retargets the singleton) diff viewer window for a changed file.
// `scope` selects which diff to show first: `staged` is HEAD↔index, `unstaged`
// is index↔worktree. The viewer loads the full changed-file list itself so arrow
// navigation flows across files regardless of the entry point.
export async function openDiffWindow(input: {
  repoRoot: string
  focusPath: string
  scope: 'staged' | 'unstaged'
}): Promise<void> {
  await window.api.openAuxWindow({
    kind: 'diff',
    // One diff window at a time — a constant key retargets the existing window.
    singletonKey: 'diff',
    params: {
      repoRoot: input.repoRoot,
      focusPath: input.focusPath,
      scope: input.scope,
    },
    bounds: readAuxWindowBounds('diff'),
  })
}
