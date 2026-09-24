/**
 * Whether WorkspaceManager should (re-)send a session's paint visibility to
 * main.
 *
 * It sends on a change of what it wants, and also when main reports something
 * else. A pane mounting states its own visibility — from its window alone,
 * since it cannot see which workspace is active — so a pane in an inactive
 * workspace, or one that read the window between two states this manager never
 * rendered, can leave main believing the other thing. A session main reports
 * painted that should not be is hidden again; one main reports hidden that
 * should be painted is shown — but only while a pane is mounted for it, because
 * a session whose pane is gone is hidden on purpose (its teardown said so), and
 * showing it would feed a window with nothing to draw.
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
}): boolean {
  if (input.lastSent !== input.shouldPaint) return true
  if (input.shouldPaint) return !input.mainVisible && input.paneMounted
  return input.mainVisible
}
