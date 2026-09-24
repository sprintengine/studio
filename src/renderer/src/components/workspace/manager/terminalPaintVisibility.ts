/**
 * Whether WorkspaceManager should (re-)send a session's paint visibility to
 * main.
 *
 * It sends on a change of what it wants, and also when main reports something
 * else — but only for a pane of its own. A pane mounting states its own
 * visibility from its window alone (it cannot see which workspace is active),
 * so a pane in an inactive workspace can leave main believing it is painted:
 * that is hidden again, while the pane is mounted in this window. And a pane
 * that attached reporting itself hidden, in a window state this manager never
 * rendered, is shown again (see `utils/terminalPaneVisibility.ts`).
 *
 * Both corrections are limited to this window's own mounted panes so that two
 * windows can never take turns overruling each other, and the show is limited
 * to a pane that has finished attaching, so a pane between mount and attach is
 * never fed live output ahead of its replay.
 */
export function shouldSendTerminalPaintVisibility(input: {
  /** What this window wants: its active workspace, in a window that is visible. */
  shouldPaint: boolean
  /** What this manager last sent for the session, if anything. */
  lastSent: boolean | undefined
  /** What main reports (`TerminalSessionSnapshot.visible`). */
  mainVisible: boolean
  /** Whether a pane with a live xterm is mounted for the session here. */
  paneMounted: boolean
  /** Whether that pane attached reporting itself hidden, and has not been shown since. */
  paneAttachedHidden: boolean
}): boolean {
  if (input.lastSent !== input.shouldPaint) return true
  if (input.shouldPaint) return !input.mainVisible && input.paneAttachedHidden
  return input.mainVisible && input.paneMounted
}
