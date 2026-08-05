import { useWorkspaceStore } from '../store/workspaceStore'
import { focusOrAddFileTab } from './modelRegistry'
import { dispatchEditorFocusEvent } from './editorFocus'
import { openExternalFileWindow } from '../components/auxWindows/openFileWindow'

export type OpenFileSurfaceInput = {
  workspaceId: string
  path: string
  name: string
  // Some callers already hold the content (e.g. terminal file links, Git
  // open-in-editor) and seed the workspace editor buffer; others rely on the
  // EditorPanel to lazy-load it. The external window always reads disk itself.
  content?: string
  // Where inside the file to land. Search results carry these — a content match
  // is a line, not a file — and without them every hit opened at line 1. 1-based,
  // matching Monaco and ripgrep. Omitted keeps the caret wherever it was.
  lineNumber?: number
  column?: number
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
  // After the tab exists, not before: EditorPanel only honors the request when
  // the file is already its active one, and the tab switch above is what makes
  // that true. The panel defers the actual reveal to a rAF, so a model that is
  // still mounting has settled by the time the caret moves.
  if (input.lineNumber !== undefined) {
    dispatchEditorFocusEvent({
      workspaceId: input.workspaceId,
      filePath: input.path,
      line: input.lineNumber,
      column: input.column,
    })
  }
}
