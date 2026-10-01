import type { EditorRange } from '../../../../shared/editor-reveal'
import { readAuxWindowBounds } from './auxWindowPlacement'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { workspaceWorkingRoot } from '../../utils/workspaceWorktree'

// The folder the window's file tree shows for this file: the workspace's
// working root — its worktree when it has one, else its folder — the same rule
// the workspace pane's Files tab uses. Resolved by the opener, from its own
// store, so an opener in a workspace window answers from the live registry. An
// opener in another aux window answers from the snapshot it hydrated with,
// which is right unless the workspace's worktree moved since; a caller that
// knows the root better passes `rootPath`. Empty when the opener knows no
// workspace; the editor window then falls back to the file's repository.
function workingRootFor(workspaceId: string): string {
  if (!workspaceId) return ''
  try {
    const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
    return workspace ? (workspaceWorkingRoot(workspace) ?? '') : ''
  } catch {
    return ''
  }
}

// Opens (or adds a tab to) the singleton external editor window for a file. The
// window is a tabbed Monaco host: a repeat call retargets the existing window,
// which appends the file as a new tab (or focuses it if already open). Content
// is read off disk by the window itself, so only path/name/workspace travel.
//
// An agent's reveal (editor.* tools) adds three things, all optional: a
// `range` to land on and highlight, `takeFocus: false` so the window is
// retargeted where it stands (or shown inactive when new) instead of coming
// forward, and `background` so the tab is added behind the one the person is
// on. The person's own opens pass none of them and behave as they always did.
export async function openExternalFileWindow(input: {
  workspaceId: string
  path: string
  name: string
  range?: EditorRange
  takeFocus?: boolean
  background?: boolean
  /** The tree's root; resolved from the workspace when omitted. */
  rootPath?: string
}): Promise<void> {
  await window.api.openAuxWindow({
    kind: 'file',
    // One external editor window; files accumulate as tabs inside it.
    singletonKey: 'file',
    params: {
      filePath: input.path,
      fileName: input.name,
      workspaceId: input.workspaceId,
      ...(input.range ? { revealRange: JSON.stringify(input.range) } : {}),
      ...(input.background ? { revealBackground: '1' } : {}),
      // Marks an agent's open, so this window can put it behind the tab the
      // person is typing in here — which the opener cannot see.
      ...(input.takeFocus === false ? { revealByAgent: '1' } : {}),
      rootPath: input.rootPath ?? workingRootFor(input.workspaceId),
    },
    bounds: readAuxWindowBounds('file'),
    ...(input.takeFocus === false ? { focus: false } : {}),
  })
}
