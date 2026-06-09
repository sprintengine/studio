// Per-window workspace visit history backing mouse back/forward navigation
// (browser-style "take me to the workspace I was just in"), distinct from the
// sidebar-order cycling of workspace.switch.next/previous. The stack lives in
// renderer memory only — it is transient shell state, never persisted, and each
// BrowserWindow's WorkspaceManager owns its own instance.

export interface WorkspaceNavigationHistory {
  readonly entries: readonly string[]
  readonly index: number
}

export const EMPTY_WORKSPACE_NAVIGATION_HISTORY: WorkspaceNavigationHistory = {
  entries: [],
  index: -1,
}

export const WORKSPACE_NAVIGATION_HISTORY_CAP = 50

/**
 * Record that a workspace became active. Re-recording the entry at the cursor
 * is a no-op, which is what makes back/forward navigation itself safe to feed
 * back through this function: stepping moves the cursor onto the visited id
 * first, so the activation effect sees it already current and does not push.
 * Any other activation truncates the forward branch (browser semantics) and
 * appends.
 */
export function recordWorkspaceVisit(
  history: WorkspaceNavigationHistory,
  workspaceId: string,
): WorkspaceNavigationHistory {
  if (history.entries[history.index] === workspaceId) return history
  const entries = [...history.entries.slice(0, history.index + 1), workspaceId]
  const overflow = entries.length - WORKSPACE_NAVIGATION_HISTORY_CAP
  const bounded = overflow > 0 ? entries.slice(overflow) : entries
  return { entries: bounded, index: bounded.length - 1 }
}

/**
 * Move the cursor one navigable visit back (-1) or forward (1). Entries that
 * fail `isNavigable` — closed workspaces, workspaces moved to another window,
 * or the currently active workspace re-surfacing through skips — are passed
 * over without being removed; the cap on record bounds the dead weight.
 * Returns null when no navigable visit exists in that direction, leaving the
 * caller's history untouched.
 */
export function stepWorkspaceHistory(
  history: WorkspaceNavigationHistory,
  direction: -1 | 1,
  isNavigable: (workspaceId: string) => boolean,
): { history: WorkspaceNavigationHistory; workspaceId: string } | null {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const workspaceId = history.entries[index]
    if (isNavigable(workspaceId)) {
      return { history: { entries: history.entries, index }, workspaceId }
    }
  }
  return null
}
