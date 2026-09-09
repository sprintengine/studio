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
//   3. The difference counter's sentence, with the `includedHunkCount` seam
//      T7 (include-a-hunk) fills in.
//   4. The header strip's two rev labels — which are just the revisions the
//      loader already chose, said out loud.

import type * as Monaco from 'monaco-editor'

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
  // Monaco's own default. Whitespace-only lines still count as differences
  // until the person says otherwise, because a diff that quietly hid some of
  // them would be lying about the count beside it.
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
  fontFamily: string
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
}

/**
 * ── THE SEAM T7 FILLS ──────────────────────────────────────────────────────
 *
 * How many of this file's hunks are in the index. `null` means "nobody can
 * answer that yet", and the counter says the honest, shorter thing instead of
 * inventing a zero.
 *
 * `2026-09-09-include-a-hunk` (T7) is the item that replaces this body: once a
 * hunk can be staged on its own (`git apply --cached` of one hunk) the count
 * exists, and returning it here is the whole wiring — `differenceCounterLabel`
 * already prints "N differences, M included" the moment this stops returning
 * null, and `DiffViewer` already calls it on every render with the file, the
 * hunk count and the whole-file state.
 *
 * Deliberately a plain function and not a prop: the count is derived from the
 * same three facts everywhere it is needed, and threading it through the
 * component tree would give T7 a second decision to make about where it lives.
 */
export function includedHunkCount(_input: IncludedHunkCountInput): number | null {
  return null
}

/** "2 differences, 1 included" — the mockup's counter, in the three states it
 *  can honestly be in before and after T7. */
export function differenceCounterLabel(input: IncludedHunkCountInput): string {
  const { differenceCount, fileInclude } = input
  if (differenceCount <= 0) return 'No differences'
  const noun = differenceCount === 1 ? '1 difference' : `${differenceCount} differences`
  const included = includedHunkCount(input)
  if (included !== null) return `${noun}, ${included} included`
  // Before T7 the only "included" fact in the building is the whole file's, so
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
      current:
        item.status === 'deleted'
          ? { text: 'Deleted', mono: false }
          : { text: 'Staged version', mono: false },
      includable,
    }
  }

  // unstaged: the index is the baseline. An untracked file has nothing there.
  return {
    base:
      item.status === 'new'
        ? { text: 'New file', mono: false }
        : { text: 'Staged version', mono: false },
    current:
      item.status === 'deleted'
        ? { text: 'Deleted', mono: false }
        : { text: 'Current version', mono: false },
    includable,
  }
}
