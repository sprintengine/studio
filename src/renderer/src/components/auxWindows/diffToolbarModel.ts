// What the diff window's toolbar and header strip SAY, decided away from React
// and Monaco so it can be read and tested on its own (git-commit-window T4,
// mockup 2522 panel 4). `diffNavigation.ts` is the same idea for the cursor.
//
// Four things live here:
//
//   1. The Monaco option set, split into the part that can change while the
//      editor is mounted and the part that cannot. That split IS the
//      "the toggle must not remount Monaco" rule, written where a test can
//      hold it: every preference is in the live half, so switching one is
//      always an `updateOptions` call and never a new editor.
//   2. The file include box's tri-state and what a click on it does.
//   3. The difference counter's sentence, and how many of the file's
//      differences are in the index (T7, include-a-hunk).
//   4. The header strip's two rev labels — which are just the revisions the
//      loader already chose, said out loud.

import type * as Monaco from 'monaco-editor'

import type { HunkInclusionSummary } from '../../../../shared/git/hunks'
import type { DiffViewMode } from '../../store/slices/settingsSlice'
import type { DiffFileItem } from './diffFileList'
import type { BranchDiffItem } from './branchSteps'

/* ------------------------------------------------------------------ *
 * Monaco options
 * ------------------------------------------------------------------ */

/**
 * Everything about the diff a person can change from the toolbar. `diffView` is
 * the persisted app setting; the other three are this window's own session
 * state — they describe how you are reading THIS diff, not how you read diffs.
 */
export type DiffEditorPrefs = {
  diffView: DiffViewMode
  /** Monaco's `hideUnchangedRegions` — the toolbar's "collapse unchanged". */
  hideUnchanged: boolean
  wordWrap: boolean
  ignoreTrimWhitespace: boolean
}

export const DEFAULT_DIFF_EDITOR_PREFS: Omit<DiffEditorPrefs, 'diffView'> = {
  hideUnchanged: false,
  wordWrap: false,
  // Monaco's own default, and it means what it says: a line whose only change
  // is leading or trailing whitespace is NOT drawn as a difference. (The
  // comment here used to claim the opposite, which is worth naming because the
  // claim mattered — it was the reason nobody noticed the stepper and the
  // counter had stopped agreeing.)
  //
  // The counter is git's, not Monaco's, precisely because of this: `git diff
  // -U0` has no such setting and counts that line. So the two numbers CAN
  // differ, and when they do the sentence and the stepper both follow git —
  // see `includedHunkCount` below and `gitStepsRef` in DiffViewer. Monaco is
  // left to draw what it thinks is worth reading.
  ignoreTrimWhitespace: true,
}

/**
 * The half of the option set that every preference lives in — and therefore the
 * exact object handed to `editor.updateOptions` when one changes.
 *
 * The invariant `diffEditorOptions` and its test hold: a preference that
 * appeared only in the construction options would need a remount to take
 * effect, and a remount disposes the models under Monaco's diff widget
 * mid-reset (the workaround `DiffViewer.handleDiffMount` exists for). So every
 * pref is here, and the constructor merely starts from the same values.
 */
export function liveDiffEditorOptions(prefs: DiffEditorPrefs): Monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: prefs.diffView === 'side-by-side',
    hideUnchangedRegions: { enabled: prefs.hideUnchanged },
    wordWrap: prefs.wordWrap ? 'on' : 'off',
    ignoreTrimWhitespace: prefs.ignoreTrimWhitespace,
  }
}

/** The options the editor is CONSTRUCTED with: the fixed ones, then the live
 *  ones at their current value, so a window that opens on "unified" opens
 *  unified rather than flickering through side-by-side. */
export function diffEditorOptions(
  prefs: DiffEditorPrefs,
  fontFamily: string,
): Monaco.editor.IStandaloneDiffEditorConstructionOptions {
  return {
    readOnly: true,
    fontSize: 13,
    fontFamily,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    contextmenu: false,
    renderOverviewRuler: true,
    // The lane the per-hunk include boxes hang in (T7). Always on rather than
    // conditional: the gutter holds the include boxes, and a margin that
    // appeared and vanished with the file would shift the code sideways every
    // time the stepper crossed a binary file. It is a fixed option because it
    // does not move with any preference — see the test above this file's split.
    glyphMargin: true,
    // Monaco's own diff gutter — its revert arrows and their menu — is off:
    // this diff is read-only, and the ONE control between the two panes is the
    // include box (T7). Two gutters offering two different verbs on the same
    // hunk is the confusion the mockup's single box was drawn to avoid.
    renderGutterMenu: false,
    renderMarginRevertIcon: false,
    ...liveDiffEditorOptions(prefs),
  }
}

/* ------------------------------------------------------------------ *
 * The file include box
 * ------------------------------------------------------------------ */

/** The two flags `git status` gives per file, which is all the box reads. */
export type GitStageFlags = { staged: boolean; unstaged: boolean }

export type IncludeBoxState = {
  checked: boolean
  /** Some of the file is in the index and some is not, so the checkbox is mixed. */
  indeterminate: boolean
}

/**
 * The include box IS the index, the way the epic's changes list is: checked
 * means "this file's changes are staged", the dash means "some of them are".
 * A file with nothing staged is unchecked; a file with everything staged is
 * checked; the two flags being true at once is the mixed state and nothing
 * else.
 */
export function includeBoxState(entry: GitStageFlags | null): IncludeBoxState {
  if (!entry) return { checked: false, indeterminate: false }
  if (entry.staged && entry.unstaged) return { checked: false, indeterminate: true }
  return { checked: entry.staged, indeterminate: false }
}

/**
 * What a click does. A mixed box goes to fully included rather than to empty —
 * a person clicking a half-filled box is completing it, and the destructive
 * reading (throw away what is already staged) should never be the one a single
 * click picks.
 */
export function includeAction(state: IncludeBoxState): 'stage' | 'unstage' {
  return state.checked && !state.indeterminate ? 'unstage' : 'stage'
}

/**
 * Whether the include box belongs on this row at all. A branch step is a pair
 * of revisions that are already history; there is no index to put them in, so
 * the box would be a control with nothing behind it.
 */
export function isIncludable(item: DiffFileItem | null): boolean {
  return item !== null && item.kind !== 'branch'
}

/* ------------------------------------------------------------------ *
 * The difference counter
 * ------------------------------------------------------------------ */

export type IncludedHunkCountInput = {
  item: DiffFileItem | null
  /** Monaco's line-change count for the file on screen. */
  differenceCount: number
  fileInclude: IncludeBoxState
  /**
   * What the MAIN process counted for this file: every difference between HEAD
   * and the working tree, and how many of them are in the index
   * (`src/main/git-hunks.ts`). Null until that read lands, and null for a file
   * whose differences cannot be counted as hunks at all — a binary file, an
   * untracked one — where a zero would be a lie rather than an answer.
   */
  hunkSummary?: HunkInclusionSummary | null
}

/**
 * How many of this file's differences are in the index, or `null` for "nobody
 * can answer that yet" — in which case the counter says the honest, shorter
 * thing instead of inventing a zero.
 *
 * The count comes from git and never from Monaco. Monaco's line-change count is
 * a different number computed by a different algorithm (it merges what
 * `ignoreTrimWhitespace` lets it merge, and groups changes its own way), and
 * mixing the two would put a total from one beside an included count from the
 * other. So when the summary is here, BOTH halves of the sentence come from it,
 * and the gutter boxes — drawn from the same git hunks — cannot disagree with
 * the words above them.
 *
 * `total <= 0` is treated as no answer: a rename with no content change, or a
 * file whose only change is its mode, has no hunks while Monaco still has two
 * texts to compare, and "No differences" over a full screen of diff is the one
 * thing worse than saying nothing.
 */
export function includedHunkCount(input: IncludedHunkCountInput): number | null {
  const summary = input.hunkSummary
  if (!summary || summary.total <= 0) return null
  // A branch step is two commits, not an index: there is nothing for the word
  // "included" to mean, whatever the working tree happens to hold right now.
  if (!isIncludable(input.item)) return null
  return Math.max(0, Math.min(summary.included, summary.total))
}

/**
 * The number of differences the counter is counting: git's, whenever git has
 * answered, and Monaco's otherwise. Exported so the two callers of the sentence
 * — the label below and its test — read the same number.
 */
export function differenceTotal(input: IncludedHunkCountInput): number {
  return includedHunkCount(input) !== null && input.hunkSummary ? input.hunkSummary.total : input.differenceCount
}

/** "2 differences, 1 included" — the mockup's counter, in the three states it
 *  can honestly be in. */
export function differenceCounterLabel(input: IncludedHunkCountInput): string {
  const { fileInclude } = input
  const included = includedHunkCount(input)
  const total = differenceTotal(input)
  if (total <= 0) return 'No differences'
  const noun = total === 1 ? '1 difference' : `${total} differences`
  if (included !== null) return `${noun}, ${included} included`
  // A branch step has no index behind it, so the working tree's stage flags say
  // nothing about it: a historical diff of a file that happens to be staged
  // right now must not claim its own differences are "included".
  if (!isIncludable(input.item)) return noun
  // No hunk count for this file — binary, untracked, or the read has not landed
  // yet. The only "included" fact in the building is then the whole file's, so
  // that is the only claim the counter makes.
  if (fileInclude.checked && !fileInclude.indeterminate) return `${noun}, all included`
  return noun
}

/* ------------------------------------------------------------------ *
 * The header strip
 * ------------------------------------------------------------------ */

export type DiffSideLabel = {
  text: string
  /** A revision identifier, to be drawn in the mono face. Prose is not. */
  mono: boolean
}

export type HeaderStripModel = {
  /** The left half: what the file is being compared AGAINST. */
  base: DiffSideLabel
  /** The right half: what you are looking at. */
  current: DiffSideLabel
  includable: boolean
}

/** A revision, shortened for a 28px row. Anything that is not a hex oid — HEAD,
 *  a branch name — is already short and is left exactly as git spells it. */
export function shortRev(rev: string): string {
  const caret = rev.endsWith('^') ? '^' : ''
  const body = caret ? rev.slice(0, -1) : rev
  if (/^[0-9a-f]{7,40}$/i.test(body)) return `${body.slice(0, 8)}${caret}`
  return rev
}

/**
 * The two things the strip names, taken from the revisions `loadDiffContent`
 * already picked for this item — never re-derived, so the strip cannot disagree
 * with the diff under it.
 *
 *   staged    HEAD            → the staged version   (HEAD ↔ index)
 *   unstaged  Staged version  → Current version      (index ↔ worktree)
 *   branch    <sha>           → <sha> or Current version
 *
 * A side that is not there — an addition's original, a deletion's modified — is
 * said in words rather than given a revision it never had. That is the case the
 * strip is easiest to get wrong: `HEAD` beside a file HEAD has never heard of.
 */
export function headerStripModel(item: DiffFileItem | null): HeaderStripModel | null {
  if (!item) return null
  const includable = isIncludable(item)

  if (item.kind === 'branch') {
    const branch = item as BranchDiffItem
    const base: DiffSideLabel =
      branch.originalRev === null
        ? { text: 'New file', mono: false }
        : { text: shortRev(branch.originalRev), mono: true }
    const current: DiffSideLabel =
      branch.modifiedRev === null
        ? { text: 'Deleted', mono: false }
        : branch.modifiedRev === 'worktree'
          ? { text: 'Current version', mono: false }
          : { text: shortRev(branch.modifiedRev), mono: true }
    return { base, current, includable }
  }

  if (item.kind === 'staged') {
    return {
      base: item.status === 'new' ? { text: 'New file', mono: false } : { text: 'HEAD', mono: true },
      current: item.status === 'deleted' ? { text: 'Deleted', mono: false } : { text: 'Staged version', mono: false },
      includable,
    }
  }

  // unstaged: the index is the baseline. An untracked file has nothing there.
  return {
    base: item.status === 'new' ? { text: 'New file', mono: false } : { text: 'Staged version', mono: false },
    current: item.status === 'deleted' ? { text: 'Deleted', mono: false } : { text: 'Current version', mono: false },
    includable,
  }
}
