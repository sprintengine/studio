import type { JSX } from 'react'
import type { AutomationProviderGlyph } from '../../../../../shared/automations/contracts'
import { actionLabel } from './automationsFormat'

export function AutomationTypeGlyph({
  kind,
  glyph,
  label,
}: {
  kind: string
  glyph?: AutomationProviderGlyph
  /** Overrides the aria-label; defaults to the bundled-map / kind fallback. */
  label?: string
}): JSX.Element {
  const shape = (glyph && GLYPH_SHAPES[glyph]) || TYPE_SHAPES[kind] || DEFAULT_SHAPE
  return (
    <span
      role="img"
      aria-label={label ?? actionLabel(kind)}
      className="flex size-icon-sm shrink-0 items-center justify-center text-[color:var(--text-subtle)]"
    >
      {shape}
    </span>
  )
}

const glyphSvg = (paths: JSX.Element): JSX.Element => (
  <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
    {paths}
  </svg>
)

const AGENT_SHAPE = glyphSvg(
  <>
    <circle cx="8" cy="5.2" r="2.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.2 13.2a4.8 4.8 0 0 1 9.6 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>,
)

const BOARD_SHAPE = glyphSvg(
  <>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
  </>,
)

const LOOP_SHAPE = glyphSvg(
  <>
    <path
      d="M3 6.5A5 5 0 0 1 12.4 5M13 9.5A5 5 0 0 1 3.6 11"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path
      d="M12.4 2.6V5h-2.4M3.6 13.4V11h2.4"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>,
)

const DEFAULT_SHAPE = glyphSvg(
  <>
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 5v3l2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </>,
)

const GLYPH_SHAPES: Record<AutomationProviderGlyph, JSX.Element> = {
  agent: AGENT_SHAPE,
  loop: LOOP_SHAPE,
  board: BOARD_SHAPE,
  clock: DEFAULT_SHAPE,
}

const TYPE_SHAPES: Record<string, JSX.Element> = {
  'spawn-agent': AGENT_SHAPE,
  'run-skill-loop': LOOP_SHAPE,
}
