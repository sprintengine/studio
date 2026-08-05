// The editor-focus bus: `EditorPanel` listens on window for this event and, when
// it owns the named file, moves the caret and reveals the line before taking
// focus. Same shape as the panel-command bus in `panelCommands.ts` — one exported
// name plus one dispatch helper — so the shell can drive the editor without
// importing it (and without pulling Monaco into the caller's chunk).
//
// This is what makes a search result a destination rather than just a file: the
// content search knows the line it matched, and until something dispatched this
// the editor opened every hit at line 1.
export const EDITOR_FOCUS_EVENT = 'multicode:focus-editor'

export type EditorFocusRequest = {
  workspaceId: string
  filePath: string
  // 1-based, as Monaco and ripgrep both count. Omitted means "just focus" —
  // the listener leaves the caret where it was.
  line?: number
  column?: number
}

// Dispatched twice on purpose. An already-open tab has a mounted listener and
// answers the first send; a cold one is still mounting, and its listener does
// not exist yet — a single synchronous dispatch would land on nobody and the
// file would open at line 1, which is the whole bug this event exists to fix.
// The 80ms repeat is the mount-tick retry TerminalView carried inline before
// the terminal link menu lifted it, kept verbatim rather than re-tuned.
const EDITOR_MOUNT_RETRY_MS = 80

export function dispatchEditorFocusEvent(request: EditorFocusRequest): void {
  const send = () => {
    window.dispatchEvent(new CustomEvent(EDITOR_FOCUS_EVENT, { detail: request }))
  }
  window.setTimeout(send, 0)
  window.setTimeout(send, EDITOR_MOUNT_RETRY_MS)
}
