import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { MENU_GROUP_LABEL_CLASS, MENU_ROW_CLASS } from './menuClasses'
import { Popover } from './Popover'
import { FOCUS_RING_CLASS } from './tokens'

// The kit's combobox — a text field that filters a listbox (MC-2117).
//
// `Select` is select-only by design: it opens a fixed set and has no query. Every
// filter-as-you-type case in the app therefore rebuilt the pattern from scratch,
// five times, and the rebuilds disagreed about the part that matters least
// visually and most functionally: which element owns `role="combobox"`, whether
// the highlighted option is tracked with `aria-activedescendant` or by moving
// DOM focus, and whether Escape closes the popup or the whole surface.
//
// The ARIA here is `CommandPalette`'s, which the audit named a clean baseline:
// the INPUT is the combobox and keeps focus throughout, options are never
// focused, and the highlighted one is named by `aria-activedescendant`. That is
// what lets typing and arrowing work at the same time — moving real focus onto
// an option takes it off the field, so the next keystroke goes nowhere.
//
// The popup rides `Popover`, so anchoring, flipping, viewport clamping,
// outside-click and portalling are the shared ones rather than a sixth
// implementation of each.
//
// MC-2134 ruled that model for the whole app — see
// `design-system/components/combobox/component.md`. Every filter-over-a-list
// picker keeps focus in the field; the only picker that moved DOM focus onto
// its rows (`CliModelPicker`) was converted to it. That entry also carries the
// two clauses this file cannot show on its own: what a row may hold under the
// ruling, and which surfaces are deliberately NOT comboboxes.

export type ComboboxOption<T> = {
  value: T
  label: string
  /** Second line under the label. */
  hint?: string
  /** Leading glyph. */
  icon?: React.ReactNode
  disabled?: boolean
  /** Optional group heading; consecutive options sharing one are grouped. */
  group?: string
}

export type ComboboxProps<T> = {
  options: ReadonlyArray<ComboboxOption<T>>
  onSelect: (value: T) => void
  /** Accessible name for the field and its listbox. */
  ariaLabel: string
  placeholder?: string
  /** The control that opens the list. Omit for a plain full-width button.
   *  `triggerProps` carries the popup ARIA and must be spread onto the button. */
  renderTrigger?: (args: {
    open: boolean
    toggle: () => void
    ref: { current: HTMLButtonElement | null }
    triggerProps: {
      'aria-haspopup': 'menu' | 'listbox' | 'dialog' | 'true'
      'aria-expanded': boolean
      'aria-controls': string | undefined
    }
  }) => React.ReactNode
  /** Match `query` against an option. Defaults to a case-insensitive substring
   *  over label and hint. */
  filter?: (option: ComboboxOption<T>, query: string) => boolean
  /** Shown when the query matches nothing. */
  emptyLabel?: string
  className?: string
  surfaceClassName?: string
}

function defaultFilter<T>(option: ComboboxOption<T>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    option.label.toLowerCase().includes(needle) || (option.hint?.toLowerCase().includes(needle) ?? false)
  )
}

export function Combobox<T>({
  options,
  onSelect,
  ariaLabel,
  placeholder,
  renderTrigger,
  filter = defaultFilter,
  emptyLabel = 'No matches.',
  className,
  surfaceClassName,
}: ComboboxProps<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(
    () => options.filter((option) => filter(option, query)),
    [options, query, filter],
  )

  // A narrowed list can be shorter than the cursor's index. Clamping on every
  // query change keeps the highlight on a real row rather than on nothing, which
  // is what makes Enter-after-typing land on what the person is looking at.
  useEffect(() => {
    setActive((current) => (current >= matches.length ? 0 : current))
  }, [matches.length])

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const commit = useCallback(
    (option: ComboboxOption<T> | undefined) => {
      if (!option || option.disabled) return
      onSelect(option.value)
      setOpen(false)
      setQuery('')
    },
    [onSelect],
  )

  // Skips disabled rows rather than parking the highlight on one that Enter
  // would silently ignore.
  const step = useCallback(
    (delta: number) => {
      if (matches.length === 0) return
      setActive((current) => {
        let next = current
        for (let i = 0; i < matches.length; i += 1) {
          next = Math.min(Math.max(next + delta, 0), matches.length - 1)
          if (!matches[next]?.disabled) return next
          if (next === 0 && delta < 0) break
          if (next === matches.length - 1 && delta > 0) break
        }
        return current
      })
    },
    [matches],
  )

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(matches[active])
    } else if (event.key === 'Escape') {
      // The popup takes Escape before any surface behind it does — a dialog
      // hosting a combobox must not close while its list is open.
      event.stopPropagation()
      setOpen(false)
    } else if ((event.key === 'Home' || event.key === 'End') && query.length === 0) {
      // Home/End belong to the caret whenever the field has text (MC-2134's
      // ruling): this is a field you type into, and a combobox that steals them
      // leaves no way to reach the ends of a query it just filtered on. With
      // nothing typed there is no caret to serve, so they jump the list.
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : matches.length - 1)
    }
  }

  const optionId = (index: number): string => `${listId}-option-${index}`

  const field = (
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && matches[active] ? optionId(active) : undefined}
      value={query}
      placeholder={placeholder}
      onChange={(event) => {
        setQuery(event.target.value)
        setActive(0)
        if (!open) setOpen(true)
      }}
      onKeyDown={onKeyDown}
      className={[
        'h-control-sm w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]',
        'px-2 text-meta text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)]',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )

  let lastGroup: string | undefined
  const list = (
    <div id={listId} role="listbox" aria-label={ariaLabel} className="max-h-[320px] overflow-y-auto py-1">
      {matches.length === 0 ? (
        <p className="px-2 py-2 text-meta text-[color:var(--text-muted)]">{emptyLabel}</p>
      ) : (
        matches.map((option, index) => {
          const heading = option.group && option.group !== lastGroup ? option.group : null
          lastGroup = option.group
          const selected = index === active
          return (
            <React.Fragment key={`${String(option.value)}-${index}`}>
              {heading ? (
                // The menu's group label: never bolder than the rows it heads
                // (menu spec). Vertical rhythm stays here, as the class's
                // own comment says it should.
                <div aria-hidden="true" className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-2`}>
                  {heading}
                </div>
              ) : null}
              <div
                id={optionId(index)}
                ref={selected ? activeRef : undefined}
                role="option"
                aria-selected={selected}
                aria-disabled={option.disabled || undefined}
                // Pointer-down rather than click: a click fires after the field
                // has already lost focus, and the blur closes the popup out from
                // under the pointer.
                onPointerDown={(event) => {
                  event.preventDefault()
                  commit(option)
                }}
                onPointerEnter={() => !option.disabled && setActive(index)}
                // The shared menu row (`Select` takes the same one): full-bleed
                // fill, same inset and gap as an action row, so a value list
                // and an action list do not drift apart. The moving highlight
                // is `--bg-hover` — what `Select` gives its active option and
                // what the combobox ruling names; `--bg-selected` is for a
                // persisted value, which this list does not show. A disabled
                // row dims the way every disabled control does rather than by
                // ink alone.
                className={[
                  MENU_ROW_CLASS,
                  'cursor-pointer text-meta',
                  option.disabled ? 'cursor-not-allowed opacity-45' : '',
                  index === active
                    ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-default)]',
                ].join(' ')}
              >
                {option.icon ? <span className="flex size-icon-sm shrink-0 items-center justify-center">{option.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">{option.hint}</span>
                ) : null}
              </div>
            </React.Fragment>
          )
        })
      )}
    </div>
  )

  // One shape: a trigger opens a surface carrying the field above the list.
  //
  // There is deliberately no "inline field" variant. `Popover` hands its trigger
  // a button ref and owns anchoring, flipping, clamping and outside-click, and
  // an inline field would have to either fight that contract or hand-roll an
  // absolutely-positioned surface — which `lint-panel-composition`'s
  // `no-bespoke-popover-shell` rule forbids outright, for the reasons that rule
  // exists. A caller wanting the field to BE the control passes a full-width
  // trigger styled as one; the list still opens on the shared engine.
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="listbox"
      placement="bottom-start"
      surfaceClassName={surfaceClassName}
      // Focus goes to the field, never to an option: the field is the combobox
      // and must keep focus so typing and arrowing work at the same time.
      onOpenAutoFocus={() => inputRef.current?.focus()}
      renderTrigger={({ ref, open: isOpen, togglePopover, triggerProps }) =>
        renderTrigger ? (
          renderTrigger({ open: isOpen, toggle: togglePopover, ref, triggerProps })
        ) : (
          <button
            ref={ref}
            type="button"
            {...triggerProps}
            onClick={togglePopover}
            className={[
              'h-control-sm w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]',
              'px-2 text-left text-meta text-[color:var(--text-muted)]',
              FOCUS_RING_CLASS,
              className ?? '',
            ].join(' ')}
          >
            {placeholder ?? ariaLabel}
          </button>
        )
      }
    >
      <div className="border-b border-[color:var(--border-subtle)] p-1">{field}</div>
      {list}
    </Popover>
  )
}
