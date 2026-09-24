// Panes that finished attaching to their session while telling main they were
// hidden (their window was not visible when they mounted).
//
// WorkspaceManager decides paint visibility, and normally sends it only when
// what it wants changes. A pane that attached hidden in a state WorkspaceManager
// never rendered — the window hidden and shown again between two renders —
// would stay hidden for good, so WorkspaceManager shows exactly these again.
// Only once the pane has attached: a pane still between mounting and its
// attach (a remount, a relaunch) has not been painted yet, and showing it then
// would forward live output ahead of the replay it is about to be sent.

const attachedHidden = new Set<string>()

/** The pane for this session attached, reporting itself hidden. */
export function notePaneAttachedHidden(sessionId: string): void {
  attachedHidden.add(sessionId)
}

/** The pane was shown, or went away: nothing left to correct. */
export function clearPaneAttachedHidden(sessionId: string): void {
  attachedHidden.delete(sessionId)
}

export function paneAttachedHidden(sessionId: string): boolean {
  return attachedHidden.has(sessionId)
}
