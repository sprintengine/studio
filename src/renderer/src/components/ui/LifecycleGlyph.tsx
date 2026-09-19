import type { JSX } from 'react'
import type { TooltipChildProps } from './Tooltip'
import type { LifecycleState } from '../../../../shared/lifecycle-state'

// One shape-coded lifecycle vocabulary shared by Backlog readiness and every
// module's own task states. State reads by shape (ring / dashed / spinner / inner-dot /
// "!" / check / slash / "×"), never by color alone — color only reinforces.
//
// The 6 px StatusDot stays the app's "live right now" idiom; this glyph carries
// the richer lifecycle that a worklist needs, replacing per-row status dots
// there.
// Domain-agnostic: callers map their own status enum to a LifecycleState. The
// union is declared on a core shared path (`src/shared/lifecycle-state.ts`) so
// main-process and shared code can name a state without importing the
// renderer; this re-export keeps every existing import site working unchanged.
export type { LifecycleState } from '../../../../shared/lifecycle-state'

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
  needs_input: 'text-[color:var(--tone-warn)]',
  done: 'text-[color:var(--tone-good)]',
  archived: 'text-[color:var(--text-disabled)]',
  failed: 'text-[color:var(--tone-error)]',
}

// In progress as a quarter-filled gauge: the accent arc rotates (spinner) when
// live. The path starts at 12 o'clock and sweeps clockwise.
const PROGRESS_ARC = 'M8 3a5 5 0 0 1 5 5'

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
    ) : state === 'in_progress' ? (
      <>
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.22" />
        <path d={PROGRESS_ARC} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
    <svg
      viewBox="0 0 16 16"
      fill="none"
      {...a11y}
      {...rest}
      className={`icon-sm shrink-0 ${spin} ${TONE[state]} ${className ?? ''}`}
    >
      {shapes}
    </svg>
  )
}
