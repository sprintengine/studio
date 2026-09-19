import React, { useCallback, useRef, useState, type JSX } from 'react'

import { IconButton, MenuOption, Popover, type SelectItem } from '../ui'
import { MENU_GROUP_LABEL_CLASS, MENU_LIST_CLASS } from '../ui/menuClasses'
import type { BacklogGroup, BacklogSort, BacklogView } from '../../utils/backlogTriage'

// The Backlog toolbar's filter/sort affordance. The lens + sort controls used to
// sit in the toolbar as two always-visible dropdowns; they now collapse behind a
// single glyph (progressive disclosure) so search is the only at-rest control
// above the list. Because hiding the controls would also hide that a lens/sort
// is applied, the trigger marks itself active — accent tint + a 6 px dot, and an
// accessible name that says so — whenever either axis is off its default.
//
// The surface is a `menu` of two `group`s of `menuitemradio` options (View,
// Sort by); the checked option in each group is that group's tab stop, with
// Arrow/Home/End roving across the whole list — the same keyboard contract as
// OverflowMenu. Picking an option does not close the menu, so both axes can be
// set in one visit; Escape / outside-click close and restore focus to the glyph.

type BacklogFilterMenuProps = {
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
  viewItems: ReadonlyArray<SelectItem<BacklogView>>
  sortItems: ReadonlyArray<SelectItem<BacklogSort>>
  groupItems: ReadonlyArray<SelectItem<BacklogGroup>>
  onViewChange: (view: BacklogView) => void
  onSortChange: (sort: BacklogSort) => void
  onGroupChange: (group: BacklogGroup) => void
  className?: string
}

const OPTION_SELECTOR = '[data-filter-option="true"]'

// The "no filter applied" baseline the active marker is measured against.
const DEFAULT_VIEW: BacklogView = 'active'
const DEFAULT_SORT: BacklogSort = 'recent'
const DEFAULT_GROUP: BacklogGroup = 'none'

export function BacklogFilterMenu({
  view,
  sort,
  group,
  viewItems,
  sortItems,
  groupItems,
  onViewChange,
  onSortChange,
  onGroupChange,
  className,
}: BacklogFilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)

  // On open, land focus on the checked View option (or the first option) so the
  // menu is immediately keyboard-operable from its current state.
  const focusSelected = useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    const checked = surface.querySelector<HTMLButtonElement>(`${OPTION_SELECTOR}[data-selected="true"]`)
    const target = checked ?? surface.querySelector<HTMLButtonElement>(OPTION_SELECTOR)
    target?.focus()
  }, [])

  const focusByOffset = (current: HTMLElement, offset: 1 | -1) => {
    const surface = surfaceRef.current
    if (!surface) return
    const nodes = Array.from(surface.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR))
    const idx = nodes.indexOf(current as HTMLButtonElement)
    if (idx < 0 || nodes.length === 0) return
    nodes[(idx + offset + nodes.length) % nodes.length]?.focus()
  }

  const onOptionKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusByOffset(event.currentTarget, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusByOffset(event.currentTarget, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      surfaceRef.current?.querySelector<HTMLButtonElement>(OPTION_SELECTOR)?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      const nodes = surfaceRef.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR)
      nodes?.[nodes.length - 1]?.focus()
    }
  }

  const active = view !== DEFAULT_VIEW || sort !== DEFAULT_SORT || group !== DEFAULT_GROUP

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Filter and sort backlog"
      popupRole="menu"
      placement="bottom-end"
      className={className}
      surfaceClassName={`min-w-[12rem] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusSelected}
      renderTrigger={({ ref, togglePopover, triggerProps, open: opened }) => (
        <IconButton
          ref={ref}
          size="xs"
          // Accent INK while the menu is open or a filter is on — never the
          // neutral `pressed` fill, which would say "selected" about a control
          // that is announcing "narrowed".
          tone={opened || active ? 'accent' : 'neutral'}
          aria-haspopup="menu"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label={active ? 'Filter and sort — filters active' : 'Filter and sort'}
          onClick={togglePopover}
          // `relative` only: the marker below is positioned against the box.
          className="relative"
        >
          <FilterGlyph />
          {active ? (
            <span
              aria-hidden="true"
              /* design-tokens-allow: filters-applied marker, not a status dot — the accessible name carries the state */
              className="absolute -right-px -top-px h-1.5 w-1.5 rounded-full bg-[color:var(--accent-primary)] ring-2 ring-[color:var(--bg-app)]"
            />
          ) : null}
        </IconButton>
      )}
    >
      <FilterGroup label="View" items={viewItems} current={view} onSelect={onViewChange} onOptionKey={onOptionKey} />
      <FilterGroup
        label="Sort by"
        items={sortItems}
        current={sort}
        onSelect={onSortChange}
        onOptionKey={onOptionKey}
        divider
      />
      <FilterGroup
        label="Group"
        items={groupItems}
        current={group}
        onSelect={onGroupChange}
        onOptionKey={onOptionKey}
        divider
      />
    </Popover>
  )
}

function FilterGroup<T extends string>({
  label,
  items,
  current,
  onSelect,
  onOptionKey,
  divider,
}: {
  label: string
  items: ReadonlyArray<SelectItem<T>>
  current: T
  onSelect: (value: T) => void
  onOptionKey: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  divider?: boolean
}): JSX.Element | null {
  // An axis a consumer does not offer (a library with one fixed grouping, say)
  // renders nothing — never an empty header.
  if (items.length === 0) return null
  return (
    <div
      role="group"
      aria-label={label}
      className={`py-1 ${divider ? 'mt-1 border-t border-[color:var(--border-subtle)] pt-1.5' : ''}`}
    >
      <p className={`${MENU_GROUP_LABEL_CLASS} pb-0.5`}>{label}</p>
      {items.map((item) => {
        const selected = item.value === current
        return (
          <MenuOption
            key={String(item.value)}
            // `ui/MenuOption` wears `MENU_OPTION_CLASS` — `MENU_ITEM_CLASS`'s own shape
            // without the hover step a selection fill has to outrank.
            // design-tokens-allow: 2026-09-08 — the row IS the canon, the newer one.
            role="menuitemradio"
            selected={selected}
            data-filter-option="true"
            data-selected={selected || undefined}
            // The checked option is the group's tab stop (radiogroup roving);
            // Arrow/Home/End move within the surface, Enter/Space select.
            tabIndex={selected ? 0 : -1}
            onKeyDown={onOptionKey}
            onClick={() => onSelect(item.value)}
            icon={
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[color:var(--accent-primary)]">
                {selected ? <CheckGlyph /> : null}
              </span>
            }
          >
            {item.label}
          </MenuOption>
        )
      })}
    </div>
  )
}

function FilterGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
