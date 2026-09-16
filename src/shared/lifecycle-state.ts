/**
 * The app's one shape-coded lifecycle vocabulary.
 *
 * State reads by shape (ring / dashed / spinner / inner-dot / "!" / check /
 * slash / "×" / the pull request marks), never by color alone — color only
 * reinforces. The 6 px StatusDot stays the app's "live right now" idiom; this
 * vocabulary carries the richer lifecycle a worklist needs, replacing per-row
 * status dots there.
 *
 * Domain-agnostic: a caller maps its own status enum onto a `LifecycleState`.
 * Declared on this core path (not in `components/ui/LifecycleGlyph.tsx`, which
 * re-exports it) so main-process and shared code can name a state without
 * reaching into the renderer.
 */
export type LifecycleState =
  | 'todo'
  | 'idea'
  | 'ready'
  // Gated by unresolved prerequisites — would be ready, but a dependency is
  // still in flight. A held state (ring with a horizontal bar), calm neutral
  // ink: waiting on other work, never an error.
  | 'blocked'
  | 'in_progress'
  | 'paused'
  | 'review'
  | 'testing'
  | 'product'
  | 'changes_requested'
  | 'needs_input'
  // A filed evidence/gate record — a document mark with a tick. Read-only,
  // never a pending decision and never a spinner. Neutral ink.
  | 'recorded'
  | 'done'
  // Approved by automated policy rather than a human hand — the same green tick
  // as `done` but drawn as an outline ring, so "approved on your behalf" reads a
  // shade lighter than a manual approval's filled disc.
  | 'approved_auto'
  // Complete but not yet merged — a green git-branch fork, signalling "work is
  // sitting on a branch / PR", distinct by shape from the filled `done` disc
  // used for on-main completions.
  | 'done_unmerged'
  // Complete AND merged — the same git-branch fork in merged-purple
  // (--tone-merged), distinct by color from the green `done_unmerged` branch.
  | 'done_merged'
  | 'archived'
  | 'failed'
