import type { TooltipChildProps } from './Tooltip'
import type { LifecycleState } from '../../../../shared/sprintengine/run-types'

// One shape-coded lifecycle vocabulary shared by Backlog readiness and Sprint
// Engine task state. State reads by shape (ring / dashed / spinner / inner-dot /
// "!" / check / slash / "×"), never by color alone — color only reinforces. The
// 6 px StatusDot stays the app's "live right now" idiom; this glyph carries the
// richer lifecycle that a worklist needs, replacing per-row status dots there.
// Domain-agnostic: callers map their own status enum to a LifecycleState. The
// union's declaration moved to `src/shared/sprintengine/run-types.ts` (the
// shared Sprint Engine state module maps board columns to it); this re-export
// keeps every existing import site working unchanged.
export type { LifecycleState } from '../../../../shared/sprintengine/run-types'

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  todo: 'To do',
  idea: 'Idea',
  ready: 'Ready',
  blocked: 'Blocked',
  in_progress: 'In progress',
  paused: 'Paused',
  review: 'In review',
  testing: 'In testing',
  product: 'Product gate',
  changes_requested: 'Changes requested',
  needs_input: 'Needs input',
  recorded: 'Recorded',
  done: 'Done',
  approved_auto: 'Approved automatically',
  done_unmerged: 'Complete · not merged',
  done_merged: 'Merged',
  archived: 'Archived',
  failed: 'Failed',
}

const TONE: Record<LifecycleState, string> = {
  todo: 'text-[color:var(--text-subtle)]',
  idea: 'text-[color:var(--text-disabled)]',
  ready: 'text-[color:var(--accent-primary)]',
  // Blocked is held work, not live work: neutral ink so a gated item never
  // borrows the accent that means "startable right now", and never the error
  // red — waiting on a prerequisite is calm, not a defect.
  blocked: 'text-[color:var(--text-subtle)]',
  in_progress: 'text-[color:var(--accent-primary)]',
  // Paused is a held run, not a live one: neutral ink, never the accent that
  // signals "happening right now".
  paused: 'text-[color:var(--text-subtle)]',
  review: 'text-[color:var(--accent-primary)]',
  testing: 'text-[color:var(--accent-primary)]',
  product: 'text-[color:var(--accent-primary)]',
  changes_requested: 'text-[color:var(--tone-warn)]',
  needs_input: 'text-[color:var(--tone-warn)]',
  // Recorded evidence is neutral, not a status the user must act on.
  recorded: 'text-[color:var(--text-subtle)]',
  done: 'text-[color:var(--tone-good)]',
  approved_auto: 'text-[color:var(--tone-good)]',
  done_unmerged: 'text-[color:var(--tone-good)]',
  done_merged: 'text-[color:var(--tone-merged)]',
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
    ) : state === 'approved_auto' ? (
      // Approved by policy: the `done` check, but on an outline ring instead of a
      // filled disc, so an automatic approval reads a shade lighter than a manual
      // one while staying unmistakably a green tick.
      <>
        <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : state === 'recorded' ? (
      // Filed evidence: a document mark (page + folded corner) with a small tick,
      // so it reads as "recorded / on file", never as a pending review or a
      // spinning draft.
      <>
        <path
          d="M4.75 2.75h3.9l2.6 2.6v7.15a.75.75 0 0 1-.75.75h-5.75a.75.75 0 0 1-.75-.75V3.5a.75.75 0 0 1 .75-.75z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M8.5 2.9v2.15a.6.6 0 0 0 .6.6h2.05" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path
          d="M5.7 9.7l1.35 1.35 2.6-2.9"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : state === 'done_unmerged' || state === 'done_merged' ? (
      // Complete on a branch: a git-branch fork mark (the header Git idiom) rather
      // than a check, so it reads as "work sitting on a branch / PR" the way
      // GitHub's own iconography does. Shape stays constant across both states;
      // the TONE map carries merged-ness — green (--tone-good) while unmerged,
      // merged-purple (--tone-merged) once the PR lands. On-main completions have
      // no branch and render the filled `done` disc+check instead. A distinct
      // merge glyph read as noise at 16px, so color differentiates merged here.
      <>
        <circle cx="5" cy="3.6" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="5" cy="12.4" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="11" cy="4.2" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 5.15v5.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path
          d="M11 5.75v.7a3.1 3.1 0 0 1-3.1 3.1H6.5"
          stroke="currentColor"
          strokeWidth="1.3"
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
        {state === 'blocked' ? (
          // A horizontal bar across the ring: the "held at the gate" mark,
          // distinct by shape from paused (two vertical bars) and archived
          // (diagonal slash).
          <path d="M5.6 8h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
