// Shared KbdChord primitive. A presentational keyboard-chord display.
// Renders each key as a real <kbd> element so screen readers announce the
// chord with kbd semantics. Token: the monospace family wired through the
// global .font-mono rule in src/renderer/src/assets/index.css.
//
// Not interactive — the chord describes a shortcut, it does not invoke one.
// The caller wires the actual keyboard handler on the control the chord
// labels (button, menu item, etc.).
import React from 'react'

type KbdChordProps = {
  /** Ordered keys, e.g. ['Cmd', 'K'] or ['Shift', 'Enter']. */
  keys: readonly string[]
  /** Visual separator between keys. Defaults to a thin '+' glyph. */
  separator?: React.ReactNode
  /** Accessible name for the chord, e.g. "Command K". Joined keys when omitted. */
  ariaLabel?: string
  className?: string
}

export function KbdChord({ keys, separator, ariaLabel, className }: KbdChordProps) {
  const label = ariaLabel ?? keys.join(' ')
  const sep = separator ?? '+'
  return (
    <span
      role="img"
      aria-label={label}
      className={['inline-flex items-center gap-1', className ?? ''].join(' ')}
    >
      {keys.map((key, index) => (
        <React.Fragment key={`${index}-${key}`}>
          {index > 0 ? (
            <span
              aria-hidden="true"
              className="font-mono text-[10px] text-[color:var(--text-disabled)]"
            >
              {sep}
            </span>
          ) : null}
          <kbd className="font-mono inline-flex h-4 min-w-[16px] items-center justify-center rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1 text-[10px] text-[color:var(--text-muted)]">
            {key}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  )
}
