import type { EditorRange } from '../../../../shared/editor-reveal'
import { readAuxWindowBounds } from './auxWindowPlacement'

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
    },
    bounds: readAuxWindowBounds('file'),
    ...(input.takeFocus === false ? { focus: false } : {}),
  })
}
