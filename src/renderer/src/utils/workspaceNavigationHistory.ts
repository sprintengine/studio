// Per-window navigation visit history backing mouse and title-bar back/forward
// (browser-style "take me to where I just was"), distinct from the sidebar-order
// cycling of workspace.switch.next/previous. The stack lives in renderer memory
// only — it is transient shell state, never persisted, and each BrowserWindow's
// WorkspaceManager owns its own instance.
//
// An entry is a workspace card, a full-page "door" global surface
// (Roadmap/Reviews/Automations), or the New chat door. All share the stack so
// Back returns to the previously-visited door, not just the workspace
// underneath it — and so New chat is a place Forward can come back to
// (new-chat-survives-back-and-forward, 2026-09-04): before it was an entry,
// Back stepped off the panel to the workspace before it and Forward had
// nowhere to go, and the draft the panel held went with it.

export type NavHistoryEntry =
  | { readonly kind: 'workspace'; readonly id: string }
  | {
      readonly kind: 'surface'
      readonly id: string
      /**
       * The VIEW of a multi-view door, when it has one — the Extensions door's
       * Plugins / Skills / Agent CLIs. Without it a step into that door landed
       * on whatever view its `onOpen` reset to, so Back out of Skills came
       * back to Plugins and Skills was unreachable by history at all. It is
       * part of the entry's identity, so moving between two views of one door
       * is a visit like any other.
       */
      readonly view?: string
    }
  | { readonly kind: 'new-chat'; readonly id: 'new-chat' }

/** The one New chat location: a window has at most one New chat door. */
export const NEW_CHAT_NAV_ENTRY: NavHistoryEntry = { kind: 'new-chat', id: 'new-chat' }

export interface WorkspaceNavigationHistory {
  readonly entries: readonly NavHistoryEntry[]
  readonly index: number
}

export const EMPTY_WORKSPACE_NAVIGATION_HISTORY: WorkspaceNavigationHistory = {
  entries: [],
  index: -1,
}

export const WORKSPACE_NAVIGATION_HISTORY_CAP = 50

function sameEntry(a: NavHistoryEntry | undefined, b: NavHistoryEntry): boolean {
  if (a === undefined || a.kind !== b.kind || a.id !== b.id) return false
  // Two views of one door are two places; a door with no views compares as it
  // always did (both sides carry `undefined`).
  return a.kind !== 'surface' || a.view === (b as { view?: string }).view
}

/**
 * Record that a location (a workspace or a door surface) became active.
 * Re-recording the entry at the cursor is a no-op, which is what makes
 * back/forward navigation itself safe to feed back through this function:
 * stepping moves the cursor onto the visited entry first, so the activation
 * effect sees it already current and does not push. Any other activation
 * truncates the forward branch (browser semantics) and appends.
 */
export function recordNavigationVisit(
  history: WorkspaceNavigationHistory,
  entry: NavHistoryEntry,
): WorkspaceNavigationHistory {
  if (sameEntry(history.entries[history.index], entry)) return history
  const entries = [...history.entries.slice(0, history.index + 1), entry]
  const overflow = entries.length - WORKSPACE_NAVIGATION_HISTORY_CAP
  const bounded = overflow > 0 ? entries.slice(overflow) : entries
  return { entries: bounded, index: bounded.length - 1 }
}

/**
 * Move the cursor one navigable visit back (-1) or forward (1). Entries that
 * fail `isNavigable` — closed workspaces, workspaces moved to another window, a
 * door whose module was disabled, or the currently active location re-surfacing
 * through skips — are passed over without being removed; the cap on record
 * bounds the dead weight. Returns null when no navigable visit exists in that
 * direction, leaving the caller's history untouched.
 */
export function stepNavigationHistory(
  history: WorkspaceNavigationHistory,
  direction: -1 | 1,
  isNavigable: (entry: NavHistoryEntry) => boolean,
): { history: WorkspaceNavigationHistory; entry: NavHistoryEntry } | null {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const entry = history.entries[index]
    if (isNavigable(entry)) {
      return { history: { entries: history.entries, index }, entry }
    }
  }
  return null
}
