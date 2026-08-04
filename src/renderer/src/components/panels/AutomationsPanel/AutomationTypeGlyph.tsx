import { actionLabel } from './automationsFormat'

// What an automation runs, as a shape — an agent, a sprint, a code review, a
// skill loop — in the icon family's 16-box round-stroke idiom. Type, not status:
// whatever sits beside it carries the words, so the mark never needs a tone.
//
// It lives beside the other action-kind vocabulary (`actionLabel`) rather than
// inside one surface, because both the Automations rail and the editor's head
// mark the same automation the same way, and the second copy is how they drift.
export function AutomationTypeGlyph({ kind }: { kind: string }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={actionLabel(kind)}
      className="flex size-icon-sm shrink-0 items-center justify-center text-[color:var(--text-subtle)]"
    >
      {TYPE_SHAPES[kind] ?? DEFAULT_SHAPE}
    </span>
  )
}

// The shapes are drawn on a 16 viewBox, so the box that holds them is `icon-sm`
// (16px) too. It shipped as `icon-md` (18px) inside a 16px flex box, overflowing
// by 2px on every automation row and in the editor head (MC-2098).
const glyphSvg = (paths: JSX.Element): JSX.Element => (
  <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
    {paths}
  </svg>
)

// Agent: a head-and-shoulders figure — the same idea as the spawn menu's persona rows.
const AGENT_SHAPE = glyphSvg(
  <>
    <circle cx="8" cy="5.2" r="2.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.2 13.2a4.8 4.8 0 0 1 9.6 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>,
)

// Sprint: the four-pane board mark the Sprints door uses.
const SPRINT_SHAPE = glyphSvg(
  <>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
  </>,
)

// Code review: a magnifier over the change.
const REVIEW_SHAPE = glyphSvg(
  <>
    <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.3" />
    <path d="M10 10l3.2 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>,
)

// Skill loop: the repeat arrows.
const LOOP_SHAPE = glyphSvg(
  <>
    <path d="M3 6.5A5 5 0 0 1 12.4 5M13 9.5A5 5 0 0 1 3.6 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M12.4 2.6V5h-2.4M3.6 13.4V11h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </>,
)

// Queue tick (Switchboard): stacked lines advancing.
const QUEUE_SHAPE = glyphSvg(
  <>
    <path d="M3 4.5h10M3 8h6.5M3 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M11 9.5l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </>,
)

// Unknown/third-party action: the automations clock.
const DEFAULT_SHAPE = glyphSvg(
  <>
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 5v3l2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </>,
)

const TYPE_SHAPES: Record<string, JSX.Element> = {
  'spawn-agent': AGENT_SHAPE,
  'run-skill-loop': LOOP_SHAPE,
  'watchtower-review': REVIEW_SHAPE,
  'sprint-engine-run': SPRINT_SHAPE,
  'sprint-engine-start': SPRINT_SHAPE,
  'switchboard-runner-tick': QUEUE_SHAPE,
}
