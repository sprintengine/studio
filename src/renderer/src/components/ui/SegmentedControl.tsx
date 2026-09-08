// Shared segmented control: a bordered strip of mutually exclusive
// choices (WAI-ARIA radiogroup pattern). One always-selected value; arrow keys
// move the selection directly (selection follows focus), so the group is a
// single tab stop. Use for 2–4 short labels where the options deserve equal
// visual weight — longer or hint-carrying choices belong to radio rows.
import React, { useCallback, useRef } from 'react'
import { FOCUS_RING_CLASS } from './tokens'
import { Tooltip } from './Tooltip'

export type SegmentedControlItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
  /** Required on an `iconOnly` strip. The glyph is `aria-hidden`; `label`
   *  carries the name. */
  icon?: React.ReactNode
  /** Hover/focus text on an `iconOnly` strip; defaults to `label`. */
  tooltip?: string
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
  /**
   * Square `size.control.xs` segments carrying each item's `icon` instead of
   * its `label` (design-system/components/segmented-control, `--icon-only`,
   * 2026-09-09). For a band that cannot spend width on words — the diff
   * window's side-by-side / unified toggle, sharing its row with the file
   * stepper and the include counter.
   *
   * THE LABEL DOES NOT DISAPPEAR. It becomes the segment's `aria-label` and its
   * tooltip, which is the carve-out `tabs --icon-only` already wrote to the
   * "no glyphs-as-labels" rule: a segment with no label and no tooltip is a
   * blank button, and it is the only thing this variant can get wrong.
   *
   * The square matches the `button --icon` items beside it in a `Toolbar` band
   * rather than standing a step taller than them.
   */
  iconOnly?: boolean
  className?: string
}

const SEGMENT_SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-control-xs px-2.5 text-micro',
  md: 'h-control-sm px-3 text-meta',
}

/** Square, `size.control.xs`, glyph at `icon.size.sm`: the strip sits level
 *  with the `button --icon` items beside it in a Toolbar band. */
const ICON_ONLY_SEGMENT = 'size-control-xs justify-center px-0'

export function SegmentedControl<V extends string = string>({
  ariaLabel,
  ariaDescribedBy,
  items,
  value,
  onChange,
  size = 'md',
  iconOnly = false,
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
      className={`inline-flex overflow-hidden rounded-sm border border-[color:var(--border-default)] ${className ?? ''}`}
    >
      {items.map((item, index) => {
        const checked = item.value === value
        const segment = (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={checked}
            // Icon-only keeps the same accessible name the labelled variant
            // has; only the drawing changes.
            aria-label={iconOnly ? item.label : undefined}
            disabled={item.disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(item.value)
            }}
            className={`
              interactive ${iconOnly ? ICON_ONLY_SEGMENT : SEGMENT_SIZE[size]} font-medium ${FOCUS_RING_CLASS}
              ${index > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''}
              ${checked
                ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                : 'bg-[color:var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'}
              disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[color:var(--bg-surface)]
            `}
          >
            {iconOnly ? (
              <span aria-hidden="true" className="grid size-icon-sm place-items-center">
                {item.icon}
              </span>
            ) : (
              item.label
            )}
          </button>
        )
        // The tooltip is the sighted user's half of the same string, and it
        // opens on focus as well as hover — `Tooltip`'s contract, never a
        // native `title` on a control.
        return iconOnly ? (
          <Tooltip
            key={item.value}
            content={item.tooltip ?? item.label}
            placement="bottom"
            // The tooltip's wrapper sits between the radiogroup and its radios,
            // so it is marked presentational: a radiogroup's children are its
            // radios, and a generic span in between is a rendering detail, not
            // structure.
            wrapperRole="presentation"
          >
            {segment}
          </Tooltip>
        ) : (
          segment
        )
      })}
    </div>
  )
}
