// Shared Select primitive. A select-only combobox (WAI-ARIA 1.2 pattern):
// the trigger holds the role="combobox" and the listbox popup is opened on
// click or keyboard. Keyboard contract — kept small enough to document inline:
//
//   1. ArrowDown / ArrowUp     move the active option (skips disabled, wraps)
//   2. Home / End              jump to first / last enabled option
//   3. Enter / Space           select the active option and close
//   4. Escape                  close without selecting; focus returns to trigger
//   5. Printable characters    type-ahead; cycling buffer with 500ms reset
//
// Selection is communicated via --accent-primary on the trailing check glyph.
// All chrome is token-only; no inline hex literals.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import { FOCUS_RING_CLASS } from './tokens'

export type SelectItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
}

type SelectProps<V extends string = string> = {
  /** Required accessible name. Icon-only triggers must expose a label. */
  ariaLabel: string
  items: SelectItem<V>[]
  value: V | null
  onChange: (value: V) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

const TYPEAHEAD_RESET_MS = 500

export function Select<V extends string = string>({
  ariaLabel,
  items,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select…',
  className,
}: SelectProps<V>) {
  const [open, setOpen] = useState(false)
  const initialActive = useMemo(() => {
    const idx = items.findIndex((item) => item.value === value)
    return idx >= 0 ? idx : items.findIndex((item) => !item.disabled)
  }, [items, value])
  const [activeIndex, setActiveIndex] = useState<number>(initialActive >= 0 ? initialActive : 0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listboxRef = useRef<HTMLElement | null>(null)
  const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({ buffer: '', timer: null })
  const listboxId = useId()

  const selectedItem = useMemo(
    () => items.find((item) => item.value === value) ?? null,
    [items, value],
  )

  const openMenu = useCallback(() => {
    if (disabled) return
    const idx = items.findIndex((item) => item.value === value)
    const enabledFirst = items.findIndex((item) => !item.disabled)
    setActiveIndex(idx >= 0 ? idx : enabledFirst >= 0 ? enabledFirst : 0)
    setOpen(true)
  }, [disabled, items, value])

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const node = listboxRef.current?.querySelector<HTMLLIElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  useEffect(() => {
    return () => {
      const state = typeaheadRef.current
      if (state.timer != null) window.clearTimeout(state.timer)
    }
  }, [])

  const moveActive = useCallback(
    (delta: 1 | -1) => {
      const len = items.length
      if (len === 0) return
      let idx = activeIndex
      for (let step = 0; step < len; step += 1) {
        idx = (idx + delta + len) % len
        if (!items[idx]?.disabled) {
          setActiveIndex(idx)
          return
        }
      }
    },
    [activeIndex, items],
  )

  const selectAt = useCallback(
    (index: number) => {
      const item = items[index]
      if (!item || item.disabled) return
      onChange(item.value)
      close(true)
    },
    [items, onChange, close],
  )

  const handleTypeahead = useCallback(
    (char: string) => {
      const state = typeaheadRef.current
      state.buffer += char.toLowerCase()
      if (state.timer != null) window.clearTimeout(state.timer)
      state.timer = window.setTimeout(() => {
        state.buffer = ''
        state.timer = null
      }, TYPEAHEAD_RESET_MS)
      const match = items.findIndex(
        (item) => !item.disabled && item.label.toLowerCase().startsWith(state.buffer),
      )
      if (match >= 0) setActiveIndex(match)
    },
    [items],
  )

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return
      if (event.key === 'Escape') {
        if (open) {
          event.preventDefault()
          close(true)
        }
        return
      }
      if (!open) {
        if (
          event.key === 'ArrowDown' ||
          event.key === 'ArrowUp' ||
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          event.preventDefault()
          openMenu()
          return
        }
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          openMenu()
          handleTypeahead(event.key)
        }
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveActive(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(-1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        const idx = items.findIndex((item) => !item.disabled)
        if (idx >= 0) setActiveIndex(idx)
      } else if (event.key === 'End') {
        event.preventDefault()
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (!items[i]?.disabled) {
            setActiveIndex(i)
            break
          }
        }
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectAt(activeIndex)
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        handleTypeahead(event.key)
      }
    },
    [open, disabled, openMenu, close, moveActive, items, selectAt, activeIndex, handleTypeahead],
  )

  const activeOptionId = open ? `${listboxId}-option-${activeIndex}` : undefined

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="listbox"
      className={className}
      surfaceAs="ul"
      surfaceClassName="max-h-[240px] min-w-full overflow-y-auto py-1"
      onOpenAutoFocus={(surface) => {
        listboxRef.current = surface
      }}
      renderTrigger={({ ref, triggerProps }) => (
        <button
          ref={(node) => {
            triggerRef.current = node
            ref.current = node
          }}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={triggerProps['aria-controls']}
          aria-activedescendant={activeOptionId}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => (open ? close(false) : openMenu())}
          onKeyDown={onKey}
          className={[
            'interactive inline-flex h-7 w-full min-w-[140px] items-center justify-between gap-2',
            'rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]',
            'px-2 text-left text-[12px]',
            'text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)]',
            'disabled:cursor-not-allowed disabled:opacity-45',
            FOCUS_RING_CLASS,
          ].join(' ')}
        >
          <span
            className={[
              'min-w-0 flex-1 truncate',
              selectedItem ? '' : 'text-[color:var(--text-muted)]',
            ].join(' ')}
          >
            {selectedItem ? selectedItem.label : placeholder}
          </span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
            className="shrink-0 text-[color:var(--text-muted)]"
          >
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    >
          {items.map((item, index) => {
            const selected = item.value === value
            const active = index === activeIndex && !item.disabled
            return (
              <li
                key={item.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={selected}
                aria-disabled={item.disabled || undefined}
                data-option-index={index}
                onMouseEnter={() => {
                  if (!item.disabled) setActiveIndex(index)
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                }}
                onClick={() => selectAt(index)}
                className={[
                  'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px]',
                  item.disabled ? 'cursor-not-allowed opacity-45' : '',
                  active ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {selected ? (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                    focusable="false"
                    className="shrink-0 text-[color:var(--accent-primary)]"
                  >
                    <path
                      d="M2 5.2l2 2 4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </li>
            )
          })}
    </Popover>
  )
}
