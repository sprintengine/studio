import React, { useCallback } from 'react'

import { FOCUS_RING_CLASS } from './tokens'

type SwitchProps = {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name. Required unless `ariaLabelledBy` is supplied. */
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  /** Stable id so a sibling <label htmlFor=...> or Field can target the control. */
  id?: string
  disabled?: boolean
  className?: string
}

export function Switch({
  checked,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  id,
  disabled = false,
  className,
}: SwitchProps) {
  const toggle = useCallback(() => {
    if (disabled) return
    onChange(!checked)
  }, [checked, disabled, onChange])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return
      if (event.key === ' ') {
        event.preventDefault()
        toggle()
      } else if (event.key === 'Enter') {
        // ARIA switch contract: Enter does not toggle; only Space does.
        event.preventDefault()
      }
    },
    [disabled, toggle],
  )

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={[
        // 32×18 track, 12px thumb, 2px inset at both ends. The off-state
        // hairline is an inset shadow rather than a border so the content box
        // stays a true 32px: a layout border would push the thumb 1px in on
        // the off state only, and would pop rather than fade on toggle. It
        // rides `.interactive`'s box-shadow transition, and composes with the
        // focus outline instead of fighting it. Travel, press stretch, and the
        // reduced-motion guard live on `.switch-track`/`.switch-thumb` in
        // assets/index.css.
        'switch-track interactive relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked
          ? 'bg-[color:var(--accent-primary)] shadow-[inset_0_0_0_1px_transparent]'
          : 'bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--border-default)]',
        // The shared treatment, with nothing local about it. This control is why
        // that treatment carries an offset: checked, the track paints
        // --accent-primary, --border-focus resolves to the same value, and the
        // zero-offset ring it used to be merged into the track.
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          // Thumb color: when ON, use --text-on-accent (the high-contrast
          // foreground for the accent surface — same token PrimaryButton uses
          // for its label). When OFF, use --text-strong (high-contrast
          // against --bg-active). This guarantees thumb visibility on every
          // theme regardless of accent luma; the previous static
          // --text-strong broke on themes where accent + text were both
          // bright (Conifer gold + pale sage, Lantern amber + warm cream,
          // Graphite white + light grey).
          'switch-thumb inline-block h-3 w-3 rounded-full',
          checked
            ? 'bg-[color:var(--text-on-accent)]'
            : 'bg-[color:var(--text-strong)]',
        ].join(' ')}
      />
    </button>
  )
}
