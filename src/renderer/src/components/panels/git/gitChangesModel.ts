// The Changes view's model: git's status snapshot turned into the checklist the
// panel renders (epic `git-commit-window`, T5). Pure — no React, no DOM, no
// `window.api` — because everything interesting about this view is arithmetic
// on three booleans, and arithmetic that can only be proved by mounting a panel
// is arithmetic nobody proves.
//
// THE CHECKBOX IS THE INDEX. That is the whole idea the Staged / Unstaged
// sections used to render as structure: a file is checked when git has it in
// the index and nowhere else, unchecked when it has changes that are not in the
// index and nothing in it, and MIXED when both are true — the file that was
// staged and then edited again. A click on a mixed box stages the rest; it
// never unstages, because the person ticking a half-ticked box is completing
// it (`nextCheckIntent` below).
//
// GROUPS, PLURAL, FROM THE START. There is one group today ("Changes") plus the
// conflicts that sit above it, and T6 turns that into changelists — named,
// app-owned sets of paths, one of them active, plus an Untracked group. So the
// builder takes a LIST of group definitions and the view renders whatever it
// returns; adding a changelist is adding a definition, not rewriting the list.

import {
  DEFAULT_CHANGELIST_ID,
  orderedChangelists,
  type Changelist,
} from '../../../../../shared/git/changelists'
import type { CheckRowCheckedState } from '../../ui/CheckRow'

/** How many rows one group renders before the rest are summarised. Four hundred
 *  `CheckRow`s is fine; four thousand is a frozen panel. */
export const MAX_RENDERED_GIT_CHANGES_PER_GROUP = 500

/** A file in the checklist. `path` is the absolute path git reported, and it is
 *  ALSO the selection key: T5 dropped the old `scope\0path` key because a
 *  partially-staged file is one row now, not one row in each of two sections. */
export type GitChangeRow = {
  path: string
  relativePath: string
  /** The part the eye lands on. Never truncated by the row. */
  filename: string
  /** The rest of the path, without a trailing slash. Empty at the repo root. */
  directory: string
  status: GitFileStatus | null
  staged: boolean
  unstaged: boolean
  /** `true` fully staged · `false` not staged · `'mixed'` both. */
  checked: CheckRowCheckedState
  /** Which side of the index this row's diff opens on. */
  diffScope: 'staged' | 'unstaged'
}

/** What kind of group this is, which is what decides how its rows behave. The
 *  view switches on this, so a new kind is a new case rather than a new list.
 *
 *  `changes` is the flat group the None and Directory groupings render;
 *  `changelist` is one of the person's own lists; `untracked` is the `??`
 *  files, which get their own group at the bottom under EVERY grouping —
 *  "git has never heard of this file" is a fact about the file, not about how
 *  the person chose to arrange the panel. */
export type GitChangeGroupKind = 'conflicts' | 'changes' | 'changelist' | 'untracked'

/** How the checklist is carved up. `changelist` is the default;
 *  the other two are the toolbar's "Group by" alternatives. */
export type GitChangesGrouping = 'changelist' | 'directory' | 'none'

export type GitChangeGroup = {
  /** Stable across refreshes — it keys the expanded/collapsed state and the
   *  rows' DOM ids. */
  id: string
  kind: GitChangeGroupKind
  title: string
  /** Every row the group holds, including the ones past the render cap. */
  totalCount: number
  /** The rows actually rendered — `allRows` capped. */
  rows: GitChangeRow[]
  /** Every row, capped or not. The group's box governs the GROUP, so its state
   *  and its click both read this rather than what happens to be on screen. */
  allRows: GitChangeRow[]
  /** How many the cap held back, so the view can say so instead of lying. */
  omittedCount: number
  /** The group's tri-state box, or `null` for a group that has none (conflicts
   *  are resolved, not staged). */
  checked: CheckRowCheckedState | null
  /** Which changelist this group renders, for the actions that act on the LIST
   *  rather than on its files. Absent on the conflicts, untracked and flat
   *  groups, which are not lists anyone can rename. */
  changelistId?: string
  /** The list new changes land in wears the `active` micro-chip. */
  active?: boolean
  /** The list's own comment, which the composer offers as its placeholder when
   *  the list is active (the active list supplies the context). */
  comment?: string
}

/** Status as a word, for the row's accessible name. The tint on the filename is
 *  the visible carrier and colour is not an accessible signal, and T5 dropped
 *  the trailing status letter that used to be the text one — so this is now the
 *  ONLY textual form of the status and the row must always spend it. */
export function gitStatusWord(status: GitFileStatus | null): string | null {
  switch (status) {
    case 'new':
      return 'added'
    case 'modified':
      return 'modified'
    case 'renamed':
      return 'renamed'
    case 'deleted':
      return 'deleted'
    case 'conflicted':
      return 'conflicted'
    default:
      return null
  }
}

export function splitGitPath(relativePath: string): { directory: string; filename: string } {
  const lastSlashIndex = relativePath.lastIndexOf('/')
  if (lastSlashIndex === -1) return { directory: '', filename: relativePath }
  return {
    directory: relativePath.slice(0, lastSlashIndex),
    filename: relativePath.slice(lastSlashIndex + 1),
  }
}

/**
 * The row's tick, read off the index. An entry git reports as both staged and
 * unstaged has hunks on both sides of the index — `'mixed'`, which is a RESTING
 * state here rather than an edge case, and it outranks checked.
 *
 * An untracked file (`??`) arrives as `unstaged` with `status: 'new'`, so it
 * falls out of this as unchecked without a case of its own — which is the point:
 * ticking one is `git add`, exactly like ticking a modified file.
 */
export function entryCheckedState(entry: Pick<GitStatusEntry, 'staged' | 'unstaged'>): CheckRowCheckedState {
  if (entry.staged && entry.unstaged) return 'mixed'
  return entry.staged
}

/**
 * What a click on a row's box means. Mixed → stage (finish the job), unchecked →
 * stage, checked → unstage. The one that has to be right is mixed: unstaging
 * there would throw away the half the person had already put in the index, in
 * response to a gesture that means "all of it".
 */
export function nextCheckIntent(checked: CheckRowCheckedState): 'stage' | 'unstage' {
  return checked === true ? 'unstage' : 'stage'
}

/**
 * The group's tri-state box. Empty is UNCHECKED, not mixed: a group with
 * nothing in it has nothing staged, and a dash there would say "partly" about
 * no files at all. All-untracked is likewise unchecked — nothing is in the
 * index — and one click stages the lot.
 */
export function groupCheckedState(rows: Array<Pick<GitChangeRow, 'checked'>>): CheckRowCheckedState {
  if (rows.length === 0) return false
  let anyOn = false
  let anyOff = false
  for (const row of rows) {
    if (row.checked === 'mixed') return 'mixed'
    if (row.checked) anyOn = true
    else anyOff = true
    if (anyOn && anyOff) return 'mixed'
  }
  return anyOn
}

/**
 * The paths a group-box click acts on, and which way. Ticking stages every row
 * that is not already fully staged (a fully staged one has nothing to add);
 * unticking unstages every row with anything in the index. Rows the render cap
 * held back are INCLUDED — the box governs the group, and a group that staged
 * only its first five hundred files would be a quiet lie.
 */
export function groupToggleAction(
  rows: Array<Pick<GitChangeRow, 'path' | 'checked'>>,
  next: boolean,
): { action: 'stage' | 'unstage'; paths: string[] } {
  if (next) {
    return { action: 'stage', paths: rows.filter((row) => row.checked !== true).map((row) => row.path) }
  }
  return { action: 'unstage', paths: rows.filter((row) => row.checked !== false).map((row) => row.path) }
}

export function toGitChangeRow(entry: GitStatusEntry): GitChangeRow {
  const { directory, filename } = splitGitPath(entry.relativePath)
  return {
    path: entry.path,
    relativePath: entry.relativePath,
    filename,
    directory,
    status: entry.status,
    staged: entry.staged,
    unstaged: entry.unstaged,
    checked: entryCheckedState(entry),
    // A row with work outside the index opens on that work (index↔worktree);
    // one that is wholly staged has nothing there, so it opens HEAD↔index.
    diffScope: entry.unstaged ? 'unstaged' : 'staged',
  }
}

function byRelativePath(a: GitStatusEntry, b: GitStatusEntry): number {
  return a.relativePath.localeCompare(b.relativePath)
}

/**
 * "Git has never heard of this file": `??` in porcelain, which `git-status`
 * parses as `new` + `unstaged` with nothing in the index. A staged addition is
 * NOT untracked — git knows about it, it is in the index, and its row's tick is
 * already on. Getting this backwards is what would put "Add to git" on a file
 * that is already added.
 */
export function isUntrackedEntry(entry: Pick<GitStatusEntry, 'status' | 'staged'>): boolean {
  return entry.status === 'new' && !entry.staged
}

function cappedGroup(
  base: Omit<GitChangeGroup, 'rows' | 'allRows' | 'omittedCount' | 'totalCount' | 'checked'>,
  entries: GitStatusEntry[],
  limit: number,
): GitChangeGroup {
  const allRows = entries.map(toGitChangeRow)
  const rows = allRows.slice(0, limit)
  return {
    ...base,
    totalCount: allRows.length,
    rows,
    allRows,
    omittedCount: Math.max(0, allRows.length - rows.length),
    checked: groupCheckedState(allRows),
  }
}

/**
 * Build the groups the Changes view renders, in render order.
 *
 * Conflicts first when there are any — they are resolved rather than ticked, so
 * they carry no box and the panel draws them through its own component. Then
 * the body, carved up by `grouping`. Then the untracked files, always last and
 * always their own group.
 *
 * The changelist partition is a PARTITION, not a filter: every tracked entry
 * lands in exactly one list, and one that the store has not heard of yet (a
 * file an agent wrote a millisecond ago, before the next reconcile) falls to
 * the ACTIVE list — the same answer main will persist a moment later, so the
 * panel never shows a file in one list and then moves it to another.
 */
export function buildGitChangeGroups(
  entries: GitStatusEntry[],
  options: { limit?: number; changelists?: Changelist[]; grouping?: GitChangesGrouping } = {},
): GitChangeGroup[] {
  const limit = options.limit ?? MAX_RENDERED_GIT_CHANGES_PER_GROUP
  const grouping = options.grouping ?? 'changelist'
  const conflicts = entries.filter((entry) => entry.status === 'conflicted').sort(byRelativePath)
  const rest = entries.filter((entry) => entry.status !== 'conflicted')
  const untracked = rest.filter(isUntrackedEntry).sort(byRelativePath)
  const tracked = rest.filter((entry) => !isUntrackedEntry(entry)).sort(byRelativePath)

  const groups: GitChangeGroup[] = []
  if (conflicts.length > 0) {
    const allRows = conflicts.map(toGitChangeRow)
    const rows = allRows.slice(0, limit)
    groups.push({
      id: 'conflicts',
      kind: 'conflicts',
      title: 'Conflicts',
      totalCount: conflicts.length,
      rows,
      allRows,
      omittedCount: Math.max(0, conflicts.length - rows.length),
      // No box: a conflicted file is resolved, and staging one from a checklist
      // would mark it resolved without anyone having looked at it.
      checked: null,
    })
  }

  const lists = options.changelists ?? []
  if (grouping === 'changelist' && lists.length > 0) {
    const ordered = orderedChangelists(lists)
    const activeId = ordered.find((list) => list.active)?.id ?? DEFAULT_CHANGELIST_ID
    const byList = new Map<string, GitStatusEntry[]>(ordered.map((list) => [list.id, []]))
    const claim = new Map<string, string>()
    for (const list of ordered) for (const path of list.paths) claim.set(path, list.id)
    for (const entry of tracked) {
      const listId = claim.get(entry.relativePath) ?? activeId
      ;(byList.get(listId) ?? byList.get(activeId))?.push(entry)
    }
    for (const list of ordered) {
      groups.push(
        cappedGroup(
          {
            id: `changelist:${list.id}`,
            kind: 'changelist',
            title: list.name,
            changelistId: list.id,
            active: list.active,
            ...(list.comment ? { comment: list.comment } : {}),
          },
          byList.get(list.id) ?? [],
          limit,
        ),
      )
    }
  } else if (grouping === 'directory') {
    // One group per directory, the repository root first under its own name so
    // a top-level file is not filed under an empty heading.
    const byDirectory = new Map<string, GitStatusEntry[]>()
    for (const entry of tracked) {
      const { directory } = splitGitPath(entry.relativePath)
      const existing = byDirectory.get(directory)
      if (existing) existing.push(entry)
      else byDirectory.set(directory, [entry])
    }
    for (const directory of [...byDirectory.keys()].sort()) {
      groups.push(
        cappedGroup(
          {
            id: `directory:${directory}`,
            kind: 'changes',
            title: directory || 'Repository root',
          },
          byDirectory.get(directory) ?? [],
          limit,
        ),
      )
    }
  } else {
    groups.push(cappedGroup({ id: 'changes', kind: 'changes', title: 'Changes' }, tracked, limit))
  }

  if (untracked.length > 0) {
    groups.push(
      cappedGroup({ id: 'untracked', kind: 'untracked', title: 'Untracked files' }, untracked, limit),
    )
  }
  return groups
}

/**
 * `N of M files` — what the index holds, of what the checklist shows. Read off
 * the ENTRIES rather than the built groups so the render cap cannot make it
 * disagree with the commit button beside it: git commits the whole index, not
 * the first five hundred rows of it.
 *
 * A partially-staged file counts as checked, because part of it is what the
 * commit will take.
 */
export function commitCounts(entries: GitStatusEntry[]): { checked: number; total: number } {
  let checked = 0
  let total = 0
  for (const entry of entries) {
    if (entry.status === 'conflicted') continue
    total += 1
    if (entry.staged) checked += 1
  }
  return { checked, total }
}

export function formatCommitCounts(counts: { checked: number; total: number }): string {
  return `${counts.checked} of ${counts.total} ${counts.total === 1 ? 'file' : 'files'}`
}

/** The row's DOM id, for `aria-activedescendant`. Kept here beside the key it is
 *  built from so the list and the rows cannot spell it differently. */
export function changeRowDomId(listId: string, path: string): string {
  return `${listId}-row-${encodeURIComponent(path)}`
}

/** Every tickable row on screen, in visual order, from the groups that are open.
 *  This is the keyboard walk, the marquee's geometry, and the shift-range's
 *  ordering — a collapsed group is not on screen, so it is not in any of them. */
export function visibleChangeRows(
  groups: GitChangeGroup[],
  isExpanded: (groupId: string) => boolean,
): GitChangeRow[] {
  const out: GitChangeRow[] = []
  for (const group of groups) {
    if (group.checked === null) continue
    if (!isExpanded(group.id)) continue
    out.push(...group.rows)
  }
  return out
}

/**
 * Where the keyboard cursor goes when the list changes under it. A row that was
 * committed, discarded or refreshed away must not take the cursor with it: the
 * cursor lands on whatever is now at its old index, or on the last row if the
 * list got shorter, or nowhere if it emptied.
 */
export function nextCursorPath(
  previousOrder: string[],
  nextOrder: string[],
  cursor: string | null,
): string | null {
  if (cursor && nextOrder.includes(cursor)) return cursor
  if (nextOrder.length === 0) return null
  if (!cursor) return null
  const index = previousOrder.indexOf(cursor)
  if (index === -1) return null
  return nextOrder[Math.min(index, nextOrder.length - 1)] ?? null
}
