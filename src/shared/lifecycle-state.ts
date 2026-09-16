/**
 * The app's one shape-coded lifecycle vocabulary.
 *
 * State reads by shape (ring / dashed / spinner / inner-dot / "!" / check /
 * slash / "×"), never by color alone — color only
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
  | 'needs_input'
  | 'done'
  | 'archived'
  | 'failed'
