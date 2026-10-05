import { useWorkspaceStore } from '../store/workspaceStore'
import { focusOrAddFileTab } from './modelRegistry'
import { dispatchEditorFocusEvent } from './editorFocus'
import { queueEditorLanding } from './agentEditorReveal'
import { openExternalFileWindow } from '../components/auxWindows/openFileWindow'
import type { EditorRange } from '../../../shared/editor-reveal'
import { rememberFileVisit } from './recentFileVisits'

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

// A window with no editor of its own can take file opens elsewhere: a pane
// popped out of its workspace window hands them to that window, whose editor
// (or editor window, by the preference below) is where files open. Answers
// whether it took the open.
let fileSurfaceRedirect: ((input: OpenFileSurfaceInput) => boolean) | null = null

/** Route this window's file opens through `redirect` until the returned function is called. */
export function redirectFileSurface(redirect: (input: OpenFileSurfaceInput) => boolean): () => void {
  fileSurfaceRedirect = redirect
  return () => {
    if (fileSurfaceRedirect === redirect) fileSurfaceRedirect = null
  }
}

// Single routing point for "open this file" actions. Honors the
// `openFilesInExternalWindow` preference: when on, the file opens as a tab in the
// external editor window (pop-up); when off, it opens as a workspace editor tab.
// Migrate file-open call sites here so the preference applies uniformly.
export function openFileSurface(input: OpenFileSurfaceInput): void {
  if (fileSurfaceRedirect?.(input)) return
  if (!input.background && input.takeFocus !== false) rememberFileVisit(input.path)
  const store = useWorkspaceStore.getState()
  if (store.openFilesInExternalWindow) {
    // A file link's line hint must survive the user's separate-window
    // preference, just like an explicit range from an editor reveal.
    const range =
      input.range ??
      (input.lineNumber !== undefined
        ? { startLine: input.lineNumber, ...(input.column !== undefined ? { startColumn: input.column } : {}) }
        : undefined)
    void openExternalFileWindow({
      workspaceId: input.workspaceId,
      path: input.path,
      name: input.name,
      ...(range ? { range } : {}),
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
