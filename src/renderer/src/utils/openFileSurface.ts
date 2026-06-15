import { useWorkspaceStore } from '../store/workspaceStore'
import { focusOrAddFileTab } from './modelRegistry'
import { openExternalFileWindow } from '../components/auxWindows/openFileWindow'

export type OpenFileSurfaceInput = {
  workspaceId: string
  path: string
  name: string
  // Some callers already hold the content (e.g. terminal file links, Git
  // open-in-editor) and seed the workspace editor buffer; others rely on the
  // EditorPanel to lazy-load it. The external window always reads disk itself.
  content?: string
}

// Single routing point for "open this file" actions. Honors the sticky
// `openFilesInExternalWindow` preference: when on, the file opens as a tab in the
// external editor window (pop-up); when off, it opens as a workspace editor tab.
// Migrate file-open call sites here so the preference applies uniformly.
export function openFileSurface(input: OpenFileSurfaceInput): void {
  const store = useWorkspaceStore.getState()
  if (store.openFilesInExternalWindow) {
    void openExternalFileWindow({ workspaceId: input.workspaceId, path: input.path, name: input.name })
    return
  }
  if (input.content !== undefined) {
    store.openFile(input.workspaceId, input.path, input.name, input.content)
  }
  focusOrAddFileTab(input.workspaceId, input.path, input.name)
}
