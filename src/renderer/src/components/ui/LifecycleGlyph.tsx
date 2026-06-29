import type { TooltipChildProps } from './Tooltip'

// One shape-coded lifecycle vocabulary shared by Backlog readiness and Sprint
// Engine task state. State reads by shape (ring / dashed / spinner / inner-dot /
// "!" / check / slash / "×"), never by color alone — color only reinforces. The
// 6 px StatusDot stays the app's "live right now" idiom; this glyph carries the
// richer lifecycle that a worklist needs, replacing per-row status dots there.
// Domain-agnostic: callers map their own status enum to a LifecycleState.
export type LifecycleState =
  | 'todo'
  | 'idea'
  | 'ready'
  | 'in_progress'
  | 'paused'
  | 'review'
  | 'testing'
  | 'product'
  | 'changes_requested'
  | 'needs_input'
  | 'done'
  // Complete but not yet merged — an outline check, distinct by shape from the
  // filled `done` disc. Used by Sprint Engine runs: outline until the branch
  // merges, filled `done` once it does.
  | 'done_unmerged'
  | 'archived'
  | 'failed'

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  todo: 'To do',
  idea: 'Idea',
  ready: 'Ready',
  in_progress: 'In progress',
  paused: 'Paused',
  review: 'In review',
  testing: 'In testing',
  product: 'Product gate',
  changes_requested: 'Changes requested',
  needs_input: 'Needs input',
  done: 'Done',
  done_unmerged: 'Complete · not merged',
  archived: 'Archived',
  failed: 'Failed',
}

const TONE: Record<LifecycleState, string> = {
  todo: 'text-[color:var(--text-subtle)]',
  idea: 'text-[color:var(--text-disabled)]',
  ready: 'text-[color:var(--accent-primary)]',
  in_progress: 'text-[color:var(--accent-primary)]',
  // Paused is a held run, not a live one: neutral ink, never the accent that
  // signals "happening right now".
  paused: 'text-[color:var(--text-subtle)]',
  review: 'text-[color:var(--accent-primary)]',
  testing: 'text-[color:var(--accent-primary)]',
  product: 'text-[color:var(--accent-primary)]',
  changes_requested: 'text-[color:var(--tone-warn)]',
  needs_input: 'text-[color:var(--tone-warn)]',
  done: 'text-[color:var(--tone-good)]',
  done_unmerged: 'text-[color:var(--tone-good)]',
  archived: 'text-[color:var(--text-disabled)]',
  failed: 'text-[color:var(--tone-error)]',
}

// The pipeline as a filling gauge: the accent arc grows as a task advances. The
// in_progress arc rotates (spinner) when live; review/testing/product are the
// same gauge, static. Paths start at 12 o'clock and sweep clockwise.
const PROGRESS_ARC: Partial<Record<LifecycleState, string>> = {
  in_progress: 'M8 3a5 5 0 0 1 5 5', // ¼
  review: 'M8 3a5 5 0 0 1 0 10', // ½
  testing: 'M8 3a5 5 0 1 1 -5 5', // ¾
  product: 'M8 3a5 5 0 1 1 -3.54 1.46', // ⅞
}

export function LifecycleGlyph({
  state,
  label,
  live = true,
  className,
  ...rest
}: {
  state: LifecycleState
  /** Accessible name; omit when adjacent text already names the state. */
  label?: string
  /** Animate the in-progress spinner. Set false to freeze it (not a live run). */
  live?: boolean
  /** Extra classes — merged after the base, e.g. a `translate-y-*` nudge to
   *  align the 16px glyph against baseline-set text. */
  className?: string
} & Partial<TooltipChildProps>): JSX.Element {
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)

  // Done: filled disc with a knockout check drawn in --bg-app so it reads in
  // every theme (near-black on bright green in dark, near-white on deep green in
  // light).
  const arc = PROGRESS_ARC[state]
  const shapes =
    state === 'done' ? (
      <>
        <circle cx="8" cy="8" r="5.25" fill="currentColor" />
        <path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          className="[stroke:var(--bg-app)]"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : state === 'done_unmerged' ? (
      // Outline ring with a check drawn in the ink itself (not knocked out), so it
      // reads as "complete but not merged" — the same check, hollow rather than filled.
      <>
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : arc ? (
      <>
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.22" />
        <path d={arc} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ) : (
      <>
        <circle
          cx="8"
          cy="8"
          r="5"
          stroke="currentColor"
          strokeWidth={state === 'ready' ? 1.5 : 1.4}
          strokeDasharray={state === 'idea' ? '2.2 2.2' : undefined}
        />
        {state === 'changes_requested' ? (
          <path
            d="M9.7 5.9 6.4 8l3.3 2.1"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {state === 'needs_input' ? (
          <>
            <path d="M8 5.3v3.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="10.7" r="0.9" fill="currentColor" />
          </>
        ) : null}
        {state === 'paused' ? (
          <>
            <path d="M6.5 5.9v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M9.5 5.9v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </>
        ) : null}
        {state === 'archived' ? (
          <path d="M4.7 11.3l6.6-6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : null}
        {state === 'failed' ? (
          <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : null}
      </>
    )

  // The spinner is the only animated state, and only when genuinely live.
  const spin = state === 'in_progress' && live ? 'lifecycle-spin' : ''

  return (
    <svg viewBox="0 0 16 16" fill="none" {...a11y} {...rest} className={`icon-sm shrink-0 ${spin} ${TONE[state]} ${className ?? ''}`}>
      {shapes}
    </svg>
  )
}
