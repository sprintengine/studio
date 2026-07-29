// Shared segmented control: a bordered strip of mutually exclusive
// choices (WAI-ARIA radiogroup pattern). One always-selected value; arrow keys
// move the selection directly (selection follows focus), so the group is a
// single tab stop. Use for 2–4 short labels where the options deserve equal
// visual weight — longer or hint-carrying choices belong to radio rows.
import React, { useCallback, useRef } from 'react'
import { FOCUS_RING_CLASS } from './tokens'

export type SegmentedControlItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
}

type SegmentedControlProps<V extends string = string> = {
  /** Required accessible name for the radiogroup. */
  ariaLabel: string
  /** Id of visible copy explaining the choices (e.g. a line describing the
   *  selected option). Opt-in: without it the group is named but undescribed,
   *  which is right when the labels stand alone. */
  ariaDescribedBy?: string
  items: SegmentedControlItem<V>[]
  value: V
  onChange: (value: V) => void
  /** `md` (default) is the form-control size; `sm` is the dense variant for
   *  inline sub-controls inside compact popovers (the runtime picker's
   *  reasoning-effort segment). */
  size?: 'sm' | 'md'
  className?: string
}

const SEGMENT_SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-[26px] px-2.5 text-[11px]',
  md: 'h-[30px] px-3.5 text-[12px]',
}

export function SegmentedControl<V extends string = string>({
  ariaLabel,
  ariaDescribedBy,
  items,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedControlProps<V>) {
  const groupRef = useRef<HTMLDivElement | null>(null)

  const moveSelection = useCallback(
    (delta: number) => {
      const enabled = items.filter((item) => !item.disabled)
      if (enabled.length === 0) return
      const currentIndex = Math.max(0, enabled.findIndex((item) => item.value === value))
      const next = enabled[(currentIndex + delta + enabled.length) % enabled.length]
      onChange(next.value)
      // Selection follows focus: keep the focused element the selected segment.
      window.requestAnimationFrame(() => {
        groupRef.current
          ?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
          ?.focus()
      })
    },
    [items, value, onChange],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      onKeyDown={handleKeyDown}
      className={`inline-flex overflow-hidden rounded-md border border-[color:var(--border-default)] ${className ?? ''}`}
    >
      {items.map((item, index) => {
        const checked = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={item.disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(item.value)
            }}
            className={`
              interactive ${SEGMENT_SIZE[size]} font-medium transition-colors ${FOCUS_RING_CLASS}
              ${index > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''}
              ${checked
                ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                : 'bg-[color:var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'}
              disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[color:var(--bg-surface)]
            `}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
