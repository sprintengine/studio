import { useWorkspaceStore } from '../store/workspaceStore'
import { focusOrAddFileTab } from './modelRegistry'
import { dispatchEditorFocusEvent } from './editorFocus'
import { queueEditorLanding } from './agentEditorReveal'
import { openExternalFileWindow } from '../components/auxWindows/openFileWindow'
import type { EditorRange } from '../../../shared/editor-reveal'

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
  // An agent's reveal (editor.* tools). `range` scrolls there and briefly
  // highlights it; `takeFocus: false` leaves the keyboard — and every window —
  // where the person has it; `background` opens the tab behind the current one
  // (the person is typing). All three are off for the person's own opens.
  range?: EditorRange
  takeFocus?: boolean
  background?: boolean
  // The folder the editor window's tree shows for this file. Omitted, the
  // window opener resolves the workspace's working root (its worktree when it
  // has one), which is what every caller wants unless it knows better.
  rootPath?: string
}

// Single routing point for "open this file" actions. Honors the
// `openFilesInExternalWindow` preference: when on, the file opens as a tab in the
// external editor window (pop-up); when off, it opens as a workspace editor tab.
// Migrate file-open call sites here so the preference applies uniformly.
export function openFileSurface(input: OpenFileSurfaceInput): void {
  const store = useWorkspaceStore.getState()
  if (store.openFilesInExternalWindow) {
    void openExternalFileWindow({
      workspaceId: input.workspaceId,
      path: input.path,
      name: input.name,
      ...(input.range ? { range: input.range } : {}),
      ...(input.takeFocus === false ? { takeFocus: false } : {}),
      ...(input.background ? { background: true } : {}),
      rootPath: input.rootPath,
    })
    return
  }
  if (input.content !== undefined) {
    store.openFile(input.workspaceId, input.path, input.name, input.content)
  }
  if (input.range) {
    // Queued before the tab exists: a tab opened behind the current one mounts
    // only when the person switches to it, and the range waits for that.
    queueEditorLanding(input.workspaceId, input.path, {
      range: input.range,
      takeFocus: input.takeFocus !== false,
      highlight: input.takeFocus === false,
    })
  }
  focusOrAddFileTab(input.workspaceId, input.path, input.name, { select: !input.background })
  if (input.range) return
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
