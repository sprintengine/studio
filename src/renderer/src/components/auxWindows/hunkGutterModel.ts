// What the gutter's include boxes SAY, decided away from React and Monaco —
// git-commit-window T7, the sibling of `diffToolbarModel` for the boxes down
// the side rather than the words along the top.
//
// The whole optimistic-override dance lives here as a pair of pure functions,
// because it is the part that is easy to get wrong in a way no rendering test
// would catch: an override that outlives the write it was predicting leaves a
// box that lies about the index for good.

import type { GitHunkView, HunkInclusionSummary } from '../../../../shared/git/hunks'
import { hunkGutterLine, hunkKey } from '../../../../shared/git/hunks'
import type { DiffFileItem } from './diffFileList'

/** One drawn box: where it goes, what it shows, and what it is called. */
export type HunkBox = {
  /**
   * What this box IS, across a re-read: `hunkKey` — the hunk's side of the
   * index and its body. Not the index it was read at. The gutter draws the
   * UNION of both diffs, so two hunks share an index routinely, and including
   * one renumbers the rest; a prediction pinned to a number would land on
   * whichever hunk inherited it.
   */
  key: string
  /**
   * Unique within ONE read, and short: Monaco's widget id, and the signature
   * the gutter re-lays-out on. `key` cannot serve — a fingerprint is the hunk's
   * whole body, and joining a file's worth of them on every render to compare
   * layouts is a string nobody needs to build.
   */
  widgetId: string
  /** A line number in the MODIFIED editor — the one editor both views draw. */
  line: number
  checked: boolean
  /** A write for this hunk is in flight; the box is drawn but refuses clicks. */
  busy: boolean
  label: string
}

/**
 * The optimistic value a click leaves behind.
 *
 * `git status` is debounced by a second under the watcher and the hunks are a
 * separate read on top of that, so between the click and the next snapshot the
 * box would still show the old state. `afterRevision` is what ends it: the
 * override is dropped by the first snapshot read AFTER the one it was computed
 * from, whether that snapshot agrees with it or not. Nothing here waits for the
 * prediction to come true — a write that landed somewhere unexpected must show
 * what actually happened.
 *
 * `afterRevision` starts at `OVERRIDE_PENDING_WRITE` and is pinned to a real
 * revision by `pinOverride` when the write returns. Anything else would let a
 * read that was ALREADY IN FLIGHT when the box was clicked — the watcher's own
 * tick, a second earlier — clear the prediction before git had been asked at
 * all, flicking the box back to its old state and then forward again.
 */
export type HunkOverride = {
  /** `<kind>:<path>` — the file this prediction is about. */
  fileKey: string
  /** `hunkKey` — which box, said in the one way that survives a re-read. */
  hunkKey: string
  checked: boolean
  afterRevision: number
}

/** "No read may clear this yet": the write it predicts has not returned. */
export const OVERRIDE_PENDING_WRITE = Number.POSITIVE_INFINITY

/** The write returned; from here the next completed read is the truth. */
export function pinOverride(override: HunkOverride | null, revision: number): HunkOverride | null {
  return override ? { ...override, afterRevision: revision } : null
}

/** Which file a gutter belongs to. Includes the KIND: the same file's staged
 *  and unstaged diffs are two different sets of hunks. */
export function hunkFileKey(item: DiffFileItem | null): string | null {
  return item ? `${item.kind}:${item.path}` : null
}

/**
 * Whether a file can carry per-hunk boxes at all. A branch step is two commits
 * with no index between them, so there is nothing for a box to put a change
 * into.
 */
export function hasHunkGutter(item: DiffFileItem | null): boolean {
  return item !== null && item.kind !== 'branch'
}

/**
 * Drop an override that has served its purpose — the file changed under it, or
 * a newer snapshot has landed. Returning the SAME object when nothing changed
 * keeps this usable straight out of a `setState` updater.
 */
export function settleOverride(
  override: HunkOverride | null,
  fileKey: string | null,
  revision: number
): HunkOverride | null {
  if (!override) return null
  if (override.fileKey !== fileKey) return null
  if (revision > override.afterRevision) return null
  return override
}

/**
 * The boxes to draw. One per hunk of the diff on screen, in file order, with
 * the pending click — if there is one for this file — shown as though it had
 * already happened.
 */
export function hunkBoxes(input: {
  /** BOTH diffs' hunks, as `readFileHunks` returns them. */
  hunks: GitHunkView[]
  key: string | null
  override: HunkOverride | null
  relativePath: string
}): HunkBox[] {
  const override = settleOverrideKey(input.override, input.key)
  return input.hunks.map((hunk) => {
    const key = hunkKey(hunk)
    const pending = override?.hunkKey === key
    const checked = pending ? (override as HunkOverride).checked : hunk.included
    return {
      key,
      widgetId: `${hunk.scope}.${hunk.index}`,
      line: hunkGutterLine(hunk),
      checked,
      busy: Boolean(pending),
      // Every box in the margin needs its own name, and "hunk 3" is only a name
      // if you can see the others. The line is what a person is looking at.
      label: `${checked ? 'Exclude' : 'Include'} the change at line ${hunkGutterLine(hunk)} of ${input.relativePath}`,
    }
  })
}

function settleOverrideKey(override: HunkOverride | null, fileKey: string | null): HunkOverride | null {
  return override && override.fileKey === fileKey ? override : null
}

/**
 * The counter, told the same story the box is telling.
 *
 * The box shows the pending click immediately and the summary is a separate
 * read that lands a beat later, so without this the sentence above the diff
 * would say "2 differences, 0 included" for that beat while the box beside the
 * hunk already showed a tick — the two disagreeing about the same fact. The
 * prediction is the same one and it dies at the same moment.
 */
export function predictedSummary(
  summary: HunkInclusionSummary | null,
  override: HunkOverride | null,
  fileKey: string | null
): HunkInclusionSummary | null {
  if (!summary || !override || override.fileKey !== fileKey) return summary
  const included = summary.included + (override.checked ? 1 : -1)
  return { total: summary.total, included: Math.max(0, Math.min(included, summary.total)) }
}

/** What a click on a box does — the direction is the box's current state, and
 *  there is no third case: a hunk is in the index or it is not. */
export function hunkAction(box: Pick<HunkBox, 'checked'>): 'stage' | 'unstage' {
  return box.checked ? 'unstage' : 'stage'
}
