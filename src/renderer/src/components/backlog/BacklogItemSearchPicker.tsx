import { useMemo, useRef, useState } from 'react'

import { EmptyState, InboxSearchInput, MenuItem, MenuOption } from '../ui'

export type BacklogItemSearchOption = {
  id: string
  value: string
  title: string
  displayId?: string
  searchText?: string
}

const MAX_VISIBLE_RESULTS = 8

// The Backlog's compact relationship picker. It deliberately returns no
// options for an empty query: large workspaces should never open a menu
// containing the entire Backlog. Matching covers the human-facing item code,
// title, stored relationship value (usually a slug), and optional aliases.
export function filterBacklogItemSearchOptions(
  options: ReadonlyArray<BacklogItemSearchOption>,
  query: string,
): BacklogItemSearchOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return []
  return options.filter((option) => {
    const haystack = [option.displayId, option.title, option.value, option.searchText]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export function BacklogItemSearchPicker({
  options,
  selectedValues = [],
  onSelect,
  ariaLabel,
  placeholder = 'Search by ID or name…',
  noOptionsMessage = 'No items available.',
  multiple = false,
  resultRole = 'menu',
}: {
  options: ReadonlyArray<BacklogItemSearchOption>
  selectedValues?: ReadonlyArray<string>
  onSelect: (option: BacklogItemSearchOption) => void
  ariaLabel: string
  placeholder?: string
  noOptionsMessage?: string
  multiple?: boolean
  resultRole?: 'menu' | 'listbox'
}): JSX.Element {
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => new Set(selectedValues), [selectedValues])
  const matches = useMemo(() => filterBacklogItemSearchOptions(options, query), [options, query])
  const visible = matches.slice(0, MAX_VISIBLE_RESULTS)
  const remaining = matches.length - visible.length
  const hasQuery = query.trim().length > 0

  const moveResultFocus = (current: HTMLElement, delta: 1 | -1): void => {
    const results = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-backlog-search-result="true"]') ?? [])
    if (results.length === 0) return
    const index = results.indexOf(current)
    const next = index < 0
      ? delta === 1 ? results[0] : results[results.length - 1]
      : results[(index + delta + results.length) % results.length]
    next?.focus()
  }

  return (
    <div
      ref={rootRef}
      className="min-w-[17rem]"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.tagName === 'INPUT' && event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          moveResultFocus(target, 1)
          return
        }
        if (target.dataset.backlogSearchResult === 'true' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          event.stopPropagation()
          moveResultFocus(target, event.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      <div className="px-1.5 py-1">
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          clearAriaLabel="Clear item search"
          autoFocus
        />
      </div>
      {/* Copy a person reads is readable ink: the helper line is `text-muted`,
          and a list that came back empty is the kit's list-density empty state
          — never disabled ink, which is certified only to a non-text floor. */}
      {!hasQuery ? (
        options.length === 0 ? (
          <EmptyState density="list" title={noOptionsMessage} />
        ) : (
          <p className="px-2.5 py-2 text-meta text-[color:var(--text-muted)]">Type an item ID or name.</p>
        )
      ) : visible.length === 0 ? (
        <EmptyState density="list" title="No matching items." />
      ) : (
        <div
          role={resultRole === 'listbox' ? 'listbox' : undefined}
          aria-multiselectable={resultRole === 'listbox' && multiple ? true : undefined}
          className="max-h-[16rem] overflow-auto py-0.5"
        >
          {visible.map((option) => {
            const checked = selected.has(option.value)
            const displayId = (
              <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                {option.displayId ?? option.value}
              </span>
            )
            // A row that carries a VALUE is the kit's menu option, which emits the
            // state attribute its role actually takes. The single-select row inside
            // a `menu` is a plain `menuitem` — an action, not a value in force — so
            // it stays the kit's menu item rather than being promoted to a role it
            // never announced.
            return resultRole === 'listbox' || multiple ? (
              <MenuOption
                key={option.id}
                role={resultRole === 'listbox' ? 'option' : 'menuitemcheckbox'}
                selected={checked}
                data-menu-item="true"
                data-backlog-search-result="true"
                tabIndex={-1}
                onClick={() => onSelect(option)}
                icon={
                  multiple ? (
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                      {checked ? <CheckGlyph /> : null}
                    </span>
                  ) : null
                }
                trailing={displayId}
              >
                {option.title}
              </MenuOption>
            ) : (
              <MenuItem
                key={option.id}
                data-backlog-search-result="true"
                onClick={() => onSelect(option)}
                trailing={displayId}
              >
                {option.title}
              </MenuItem>
            )
          })}
          {remaining > 0 ? (
            <p className="px-2.5 py-1.5 text-micro text-[color:var(--text-muted)]">
              {remaining} more — refine the search.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
      <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
