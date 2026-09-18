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
//
// AGENT CHANGELISTS BROKE "ONE FILE, ONE ROW". A list can own HUNKS of a file
// whose home is another list (`spans`, shared/git/changelists), so one status
// entry now draws a row in its home list's group AND a `partial: true` row in
// every list that owns some of its lines. That is the only place in this file
// where a path appears twice, and it is why a row's identity is `key` rather
// than `path`: two rows for one file share a path, and a selection, a keyboard
// cursor and a DOM id that could not tell them apart would put the walk in a
// loop and hand a whole-file stage to whichever of the two came first.
//
// The Directory and None groupings are untouched by any of it: they arrange
// FILES, and a file is one row there whoever owns its lines.

import {
  DEFAULT_CHANGELIST_ID,
  isPartialInList,
  orderedChangelists,
  type Changelist,
} from '../../../../../shared/git/changelists'
import type { CheckRowCheckedState } from '../../ui/CheckRow'

/** How many rows one group renders before the rest are summarised. Four hundred
 *  `CheckRow`s is fine; four thousand is a frozen panel. */
export const MAX_RENDERED_GIT_CHANGES_PER_GROUP = 500

/** A file in the checklist. `path` is the absolute path git reported; `key` is
 *  the row's IDENTITY. The two were the same thing until agent changelists —
 *  T5 dropped the old `scope\0path` key because a partially-staged file is one
 *  row now rather than one in each of two sections — and they are the same
 *  thing still for every row but a `partial` one, which shares its file's path
 *  with the row in that file's home list. */
export type GitChangeRow = {
  /** Unique per rendered row: the path, or `<changelistId>\0<path>` for a
   *  guest list's partial row. Everything that has to tell two rows apart —
   *  selection, the keyboard cursor, the DOM id, the node registry, React's
   *  own key — spends this and never `path`. */
  key: string
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
  /** This row is a GUEST's view of the file: the changelist named below owns
   *  some of the file's hunks, and the file itself lives in another list. Its
   *  box stages that list's hunks and nothing else; every file-level action
   *  reached from it (discard, delete) would take lines that are not this
   *  list's, so the panel refuses them here and offers them on the home row. */
  partial?: boolean
  /** The changelist whose group this row is drawn in. Set on every row of a
   *  changelist group, home and guest alike; absent under the Directory and
   *  None groupings, which are not lists. */
  changelistId?: string
}

/** The row's identity. One spelling, in one place, because the list, the panel
 *  and the tests all key on it — and because the day it is spelled twice is the
 *  day a partial row's tick stages the whole file. */
export function changeRowKey(row: Pick<GitChangeRow, 'path' | 'partial' | 'changelistId'>): string {
  // NUL, because it is the one byte a path cannot hold — so a guest row's key
  // can never collide with some other file's plain path.
  return row.partial && row.changelistId ? `${row.changelistId}\u0000${row.path}` : row.path
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
 *
 * Guest (`partial`) rows come back in their own bucket rather than as paths,
 * because staging one means staging THIS list's hunks of that file and nothing
 * else. A caller that ignores `partialRows` stages fewer changes than the
 * person asked for; one that put them in `paths` would stage more, which is the
 * failure that matters.
 */
export function groupToggleAction<Row extends Pick<GitChangeRow, 'path' | 'checked' | 'partial'>>(
  rows: Row[],
  next: boolean,
): { action: 'stage' | 'unstage'; rows: Row[]; paths: string[]; partialRows: Row[] } {
  const wanted = next ? rows.filter((row) => row.checked !== true) : rows.filter((row) => row.checked !== false)
  return {
    action: next ? 'stage' : 'unstage',
    // Every row the click acts on, whole files and guests together — what a
    // caller that can do both hands straight to its one stage call.
    rows: wanted,
    // A guest row is NOT a path: `git add <file>` on a file this list owns two
    // hunks of would stage the other list's lines with them, which is the whole
    // thing agent changelists exist to prevent. Those rows come back separately
    // and the panel stages them a hunk at a time.
    paths: wanted.filter((row) => row.partial !== true).map((row) => row.path),
    partialRows: wanted.filter((row) => row.partial === true),
  }
}

/**
 * Which of a set of rows a WHOLE-FILE destructive action may touch, and how many
 * it must leave alone.
 *
 * Discard is `git checkout --` and delete is `unlink`; both take the file. A
 * guest row is a changelist's claim on some of a file's LINES, and there is no
 * per-hunk revert in the git layer to answer it with — so the rule is not "do
 * it anyway", it is "skip it and say so". The count comes back because the
 * confirm dialog has to name what will not happen before the person agrees to
 * what will.
 */
export function revertableRows<Row extends Pick<GitChangeRow, 'partial' | 'path'>>(
  rows: Row[],
): { actionable: Row[]; skippedPartial: number } {
  const actionable = rows.filter((row) => row.partial !== true)
  // A guest row whose FILE is already in the selection through its home row is
  // not skipped — the file is being discarded, by the row that may. Counting it
  // would put "1 file is skipped" in a dialog that is about to touch that very
  // file, which is the kind of sentence that teaches people to stop reading
  // dialogs.
  const covered = new Set(actionable.map((row) => row.path))
  const skipped = rows.filter((row) => row.partial === true && !covered.has(row.path))
  return { actionable, skippedPartial: new Set(skipped.map((row) => row.path)).size }
}

export function toGitChangeRow(
  entry: GitStatusEntry,
  membership?: { changelistId?: string; partial?: boolean },
): GitChangeRow {
  const { directory, filename } = splitGitPath(entry.relativePath)
  const partial = membership?.partial === true
  const changelistId = membership?.changelistId
  return {
    key: changeRowKey({ path: entry.path, ...(partial ? { partial } : {}), ...(changelistId ? { changelistId } : {}) }),
    path: entry.path,
    relativePath: entry.relativePath,
    filename,
    directory,
    status: entry.status,
    staged: entry.staged,
    unstaged: entry.unstaged,
    // A partial row's tick is the FILE's tri-state, not this list's. Reading
    // the list's own hunks would cost a `git diff` per row on every refresh,
    // and the box's click is already list-scoped (the panel stages exactly this
    // list's hunks), so the honest half is shown and the expensive half is the
    // v1 limitation — the diff viewer's per-hunk boxes are where the true
    // per-list state lives.
    checked: entryCheckedState(entry),
    // A row with work outside the index opens on that work (index↔worktree);
    // one that is wholly staged has nothing there, so it opens HEAD↔index.
    diffScope: entry.unstaged ? 'unstaged' : 'staged',
    ...(partial ? { partial: true as const } : {}),
    ...(changelistId ? { changelistId } : {}),
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

type GroupBase = Omit<GitChangeGroup, 'rows' | 'allRows' | 'omittedCount' | 'totalCount' | 'checked'>

function cappedRowGroup(base: GroupBase, allRows: GitChangeRow[], limit: number): GitChangeGroup {
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

function cappedGroup(base: GroupBase, entries: GitStatusEntry[], limit: number): GitChangeGroup {
  return cappedRowGroup(
    base,
    entries.map((entry) => toGitChangeRow(entry)),
    limit,
  )
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
  const lists = options.changelists ?? []
  const byChangelist = grouping === 'changelist' && lists.length > 0
  // A file an AGENT created is `??`, and T6's rule — untracked is a fact about
  // the file, so it draws in its own group under every grouping — would file
  // the agent's own new files away from the agent's list, which is the one
  // place a person looks to see what that agent did. So an untracked path whose
  // home is an OWNED list is drawn there instead. A hand-made list keeps T6's
  // rule exactly: moving an untracked file into one changes nothing on screen,
  // and the menu still says so.
  const ordered = byChangelist ? orderedChangelists(lists) : []
  const ownedHomes = new Map<string, string>()
  for (const list of ordered) {
    if (!list.owner) continue
    for (const path of list.paths) ownedHomes.set(path, list.id)
  }
  const drawsInOwnedList = (entry: GitStatusEntry): boolean =>
    isUntrackedEntry(entry) && ownedHomes.has(entry.relativePath)
  const untracked = rest.filter((entry) => isUntrackedEntry(entry) && !drawsInOwnedList(entry)).sort(byRelativePath)
  const tracked = rest.filter((entry) => !isUntrackedEntry(entry) || drawsInOwnedList(entry)).sort(byRelativePath)

  const groups: GitChangeGroup[] = []
  if (conflicts.length > 0) {
    const allRows = conflicts.map((entry) => toGitChangeRow(entry))
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

  if (byChangelist) {
    const activeId = ordered.find((list) => list.active)?.id ?? DEFAULT_CHANGELIST_ID
    const byList = new Map<string, GitChangeRow[]>(ordered.map((list) => [list.id, []]))
    const claim = new Map<string, string>()
    for (const list of ordered) for (const path of list.paths) claim.set(path, list.id)
    for (const entry of tracked) {
      const listId = claim.get(entry.relativePath) ?? activeId
      const home = byList.has(listId) ? listId : activeId
      byList.get(home)?.push(toGitChangeRow(entry, { changelistId: home }))
    }
    // The guest rows, on top of the home rows: one per list that owns hunks of
    // a file living somewhere else. `isPartialInList` is the model's own answer
    // — it is false for the home list, so a file never draws twice in one group.
    const shown = new Map(rest.map((entry) => [entry.relativePath, entry]))
    for (const list of ordered) {
      for (const path of Object.keys(list.spans ?? {}).sort()) {
        const entry = shown.get(path)
        if (!entry || !isPartialInList(list, path)) continue
        byList.get(list.id)?.push(toGitChangeRow(entry, { changelistId: list.id, partial: true }))
      }
    }
    for (const list of ordered) {
      groups.push(
        cappedRowGroup(
          {
            id: `changelist:${list.id}`,
            kind: 'changelist',
            title: list.name,
            changelistId: list.id,
            active: list.active,
            ...(list.comment ? { comment: list.comment } : {}),
          },
          (byList.get(list.id) ?? []).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
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
    groups.push(cappedGroup({ id: 'untracked', kind: 'untracked', title: 'Untracked files' }, untracked, limit))
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
 *  built from so the list and the rows cannot spell it differently — and it is
 *  built from `row.key`, not `row.path`, so a guest row and the home row of the
 *  same file are two ids rather than one id twice in the document. */
export function changeRowDomId(listId: string, rowKey: string): string {
  return `${listId}-row-${encodeURIComponent(rowKey)}`
}

/** Every tickable row on screen, in visual order, from the groups that are open.
 *  This is the keyboard walk, the marquee's geometry, and the shift-range's
 *  ordering — a collapsed group is not on screen, so it is not in any of them. */
export function visibleChangeRows(groups: GitChangeGroup[], isExpanded: (groupId: string) => boolean): GitChangeRow[] {
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
 *
 * The three arguments are ROW KEYS (`changeRowKey`), not paths: a file that has
 * a guest row as well as a home row occupies two places in the walk.
 */
export function nextCursorPath(previousOrder: string[], nextOrder: string[], cursor: string | null): string | null {
  if (cursor && nextOrder.includes(cursor)) return cursor
  if (nextOrder.length === 0) return null
  if (!cursor) return null
  const index = previousOrder.indexOf(cursor)
  if (index === -1) return null
  return nextOrder[Math.min(index, nextOrder.length - 1)] ?? null
}
