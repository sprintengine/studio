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
        'interactive relative inline-flex h-4 w-7 shrink-0 items-center rounded-full',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked
          ? 'bg-[color:var(--accent-primary)]'
          : 'border border-[color:var(--border-default)] bg-[color:var(--bg-active)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'inline-block h-3 w-3 transform rounded-full bg-[color:var(--text-strong)] transition-transform',
          checked ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}
