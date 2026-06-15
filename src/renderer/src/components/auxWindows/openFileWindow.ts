import { readAuxWindowBounds } from './auxWindowPlacement'

// Opens (or adds a tab to) the singleton external editor window for a file. The
// window is a tabbed Monaco host: a repeat call retargets the existing window,
// which appends the file as a new tab (or focuses it if already open). Content
// is read off disk by the window itself, so only path/name/workspace travel.
export async function openExternalFileWindow(input: {
  workspaceId: string
  path: string
  name: string
}): Promise<void> {
  await window.api.openAuxWindow({
    kind: 'file',
    // One external editor window; files accumulate as tabs inside it.
    singletonKey: 'file',
    params: {
      filePath: input.path,
      fileName: input.name,
      workspaceId: input.workspaceId,
    },
    bounds: readAuxWindowBounds('file'),
  })
}
