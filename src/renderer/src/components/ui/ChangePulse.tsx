import React from 'react'
import { useChangePulse, type ChangePulseOptions } from '../../hooks/useChangePulse'

export type ChangePulseProps = {
  /** The status number to watch. A change replays the icon pulse. */
  value: number
  /** Status colour the pulse flashes in, e.g. `var(--tone-error)`. */
  tint: string
  /** Layout classes for the wrapper (sizing/flex), e.g. `inline-flex`. */
  className?: string
  children: React.ReactNode
} & Pick<ChangePulseOptions, 'mode' | 'resetKey'>

/**
 * Wraps a status icon so it replays a one-shot "just changed" pulse (tint +
 * glow easing back to rest) whenever `value` moves. The pulse paints in the
 * icon's own status colour via `--pulse-tint`, so it never introduces a new
 * accent. The watched value's token is used as the wrapper `key`, which remounts
 * the wrapper and restarts the CSS animation on each change; the first render
 * never pulses. Purely decorative — keep the real count/state on a sibling badge
 * or the button's accessible name. Honours reduced-motion (see
 * `.status-icon-pulse` in `index.css`).
 */
export function ChangePulse({ value, tint, mode, resetKey, className, children }: ChangePulseProps) {
  const token = useChangePulse(value, { mode, resetKey })
  const pulsing = token > 0
  return (
    <span
      key={token}
      className={`${className ?? ''}${pulsing ? ' status-icon-pulse' : ''}`}
      style={pulsing ? ({ '--pulse-tint': tint } as React.CSSProperties) : undefined}
    >
      {children}
    </span>
  )
}
