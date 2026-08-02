// Multi-selection model for the Backlog lists (MC-2060): the Backlog door rail
// and the per-project BacklogPanel share this one pure state machine so
// shift-click / cmd-click / shift+↑↓ behave identically on both surfaces.
//
// The model deliberately does NOT own the cursor. Each list already has a
// single-selection key (`selectedKey` / `selectedId`) doing triple duty as
// roving cursor, detail binding, and selection paint; that key stays the CURSOR
// (aria-activedescendant, keyboard origin), and this state layers the extended
// selection on top:
//
//  - `keys === null`  → single-select mode. The effective selection is the
//    cursor row alone — byte-identical to the lists before this model existed.
//  - `keys` is a set  → multi-select mode. The set is the selection (it may
//    shrink to one or zero rows via cmd-click without leaving the mode; only a
//    plain click, plain arrow, or right-click on an unselected row collapses).
//  - `anchorKey` is the range pivot — the last plain- or cmd-clicked row. It is
//    also what the detail pane binds to while a multi-selection is active, so
//    extending a range never blanks or retargets the pane.
//
// Keys are opaque strings owned by the caller: the door keys rows
// `rootKey::itemId` (two projects can hold the same relative path — rowKeyOf,
// BacklogGlobalSurface), the panel keys by item id. `groupOf` carries the
// door's pinned cross-project rule: a shift/cmd-click on a row of a different
// project collapses the selection to that row, so a selection — and therefore
// the sprint bundle built from it — is always from one project.

export type BacklogMultiSelection = {
  /** Range pivot + multi-mode detail binding: the last plain/cmd-clicked row. */
  anchorKey: string | null
  /** Selected row keys; null = single-select mode (selection = cursor row). */
  keys: ReadonlySet<string> | null
}

export const EMPTY_BACKLOG_MULTI_SELECTION: BacklogMultiSelection = {
  anchorKey: null,
  keys: null,
}

export type BacklogSelectionGroupOf = (key: string) => string | undefined

/** Plain click / plain arrow: back to single-select on the clicked row. */
export function collapseBacklogSelectionTo(key: string | null): BacklogMultiSelection {
  return { anchorKey: key, keys: null }
}

/** The rows a mutation or context action targets: the multi set, else the cursor. */
export function effectiveBacklogSelection(
  state: BacklogMultiSelection,
  cursorKey: string | null,
): ReadonlySet<string> {
  if (state.keys) return state.keys
  return cursorKey ? new Set([cursorKey]) : new Set()
}

export function isBacklogMultiSelectionActive(state: BacklogMultiSelection): boolean {
  return state.keys !== null && state.keys.size > 1
}

// The row whose group the next extension must match: the anchor when it is
// still part of the selection's world, else any member of the current set.
function groupReferenceKey(
  state: BacklogMultiSelection,
  cursorKey: string | null,
): string | null {
  if (state.keys) {
    if (state.anchorKey && state.keys.has(state.anchorKey)) return state.anchorKey
    for (const key of state.keys) return key
    return state.anchorKey
  }
  return state.anchorKey ?? cursorKey
}

function crossesGroup(
  reference: string | null,
  key: string,
  groupOf: BacklogSelectionGroupOf | undefined,
): boolean {
  if (!groupOf || !reference) return false
  return groupOf(reference) !== groupOf(key)
}

/** Cmd/ctrl-click: toggle the row in the selection; the row becomes the anchor. */
export function toggleBacklogSelection(
  state: BacklogMultiSelection,
  cursorKey: string | null,
  key: string,
  groupOf?: BacklogSelectionGroupOf,
): BacklogMultiSelection {
  // Pinned decision: a different project's row never joins — collapse to it.
  if (crossesGroup(groupReferenceKey(state, cursorKey), key, groupOf)) {
    return collapseBacklogSelectionTo(key)
  }
  const base = new Set(state.keys ?? (cursorKey ? [cursorKey] : []))
  if (base.has(key)) base.delete(key)
  else base.add(key)
  return { anchorKey: key, keys: base }
}

/**
 * Shift-click (or shift+arrow landing on `key`): select the contiguous range of
 * item rows between the anchor and `key`, replacing any prior multi set. The
 * anchor stays put so successive shift-clicks re-range from the same pivot.
 * `order` is the item-row keys in list (nav) order — headers excluded. On the
 * door's cross-project list the range keeps only the target project's rows, so
 * an interleaved "All projects" sort can never smuggle another project in.
 */
export function extendBacklogSelectionTo(
  state: BacklogMultiSelection,
  cursorKey: string | null,
  key: string,
  order: ReadonlyArray<string>,
  groupOf?: BacklogSelectionGroupOf,
): BacklogMultiSelection {
  const pivot = state.anchorKey ?? cursorKey ?? key
  if (crossesGroup(pivot, key, groupOf)) return collapseBacklogSelectionTo(key)
  const from = order.indexOf(pivot)
  const to = order.indexOf(key)
  if (from < 0 || to < 0) return collapseBacklogSelectionTo(key)
  const [start, end] = from <= to ? [from, to] : [to, from]
  const group = groupOf?.(key)
  const range = order
    .slice(start, end + 1)
    .filter((candidate) => !groupOf || groupOf(candidate) === group)
  return { anchorKey: pivot, keys: new Set(range) }
}

/**
 * Drop keys that left the list (re-scan, lens or filter change). Falls back to
 * single-select when the whole selection is gone; an anchor that vanished on
 * its own resets so the next range starts from the cursor.
 */
export function pruneBacklogSelection(
  state: BacklogMultiSelection,
  validKeys: ReadonlySet<string>,
): BacklogMultiSelection {
  const anchorKey = state.anchorKey && validKeys.has(state.anchorKey) ? state.anchorKey : null
  if (!state.keys) {
    return anchorKey === state.anchorKey ? state : { anchorKey, keys: null }
  }
  const kept = [...state.keys].filter((key) => validKeys.has(key))
  if (kept.length === 0) return { anchorKey, keys: null }
  if (kept.length === state.keys.size && anchorKey === state.anchorKey) return state
  return { anchorKey, keys: new Set(kept) }
}
