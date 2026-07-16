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
  items: SegmentedControlItem<V>[]
  value: V
  onChange: (value: V) => void
  className?: string
}

export function SegmentedControl<V extends string = string>({
  ariaLabel,
  items,
  value,
  onChange,
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
              interactive h-[30px] px-3.5 text-[12px] font-medium transition-colors ${FOCUS_RING_CLASS}
              ${index > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''}
              ${checked
                ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
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
