import { useMemo, useRef, useState } from 'react'

import { InboxSearchInput } from '../ui'

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
      {!hasQuery ? (
        <p className="px-2.5 py-2 text-meta text-[color:var(--text-disabled)]">
          {options.length === 0 ? noOptionsMessage : 'Type an item ID or name.'}
        </p>
      ) : visible.length === 0 ? (
        <p className="px-2.5 py-2 text-meta text-[color:var(--text-disabled)]">No matching items.</p>
      ) : (
        <div
          role={resultRole === 'listbox' ? 'listbox' : undefined}
          aria-multiselectable={resultRole === 'listbox' && multiple ? true : undefined}
          className="max-h-[16rem] overflow-auto py-0.5"
        >
          {visible.map((option) => {
            const checked = selected.has(option.value)
            return (
              <button
                key={option.id}
                type="button"
                role={resultRole === 'listbox' ? 'option' : multiple ? 'menuitemcheckbox' : 'menuitem'}
                aria-selected={resultRole === 'listbox' ? checked : undefined}
                aria-checked={resultRole === 'menu' && multiple ? checked : undefined}
                data-menu-item="true"
                data-backlog-search-result="true"
                tabIndex={-1}
                onClick={() => onSelect(option)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-meta text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
              >
                {multiple ? (
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                    {checked ? <CheckGlyph /> : null}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{option.title}</span>
                <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                  {option.displayId ?? option.value}
                </span>
              </button>
            )
          })}
          {remaining > 0 ? (
            <p className="px-2.5 py-1.5 text-micro text-[color:var(--text-disabled)]">
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
