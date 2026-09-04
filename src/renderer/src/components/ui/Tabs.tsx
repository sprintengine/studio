import React, { useCallback, useEffect, useId, useRef } from 'react'
import { FOCUS_RING_CLASS, FOCUS_RING_INSET_CLASS } from './tokens'

export type TabItem<T extends string = string> = {
  id: T
  label: string
  /** Optional canonical count rendered next to the label. */
  count?: number | string
  /** Optional leading icon. Pass a node (e.g. <InboxIcon />) or a render
   *  function that receives a className. */
  icon?: React.ReactNode | ((props: { className?: string }) => React.ReactNode)
  disabled?: boolean
  /** Accessible name of the tab's close affordance ("Close Files"). Rendered
   *  only when the strip also has `onCloseItem`; a tab without one cannot be
   *  closed from the strip. */
  closeLabel?: string
}

type TabsProps<T extends string = string> = {
  /** Required accessible name for the tablist. */
  ariaLabel: string
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  /** Stable id prefix; auto-generated when not supplied. */
  idPrefix?: string
  className?: string
  /** Omit the built-in bottom hairline so a parent container can own the row
   *  border (needed when the tab row hosts trailing inline controls). */
  borderless?: boolean
  /** Closable strips (the workspace pane): a close glyph revealed on hover and
   *  focus sits in each closable tab's trailing padding. It is a sibling of the
   *  tab button, not a child — a button inside a button is invalid — and stays
   *  out of the tab order, so the strip remains one tab stop; keyboard closing
   *  is the host's shortcut. */
  onCloseItem?: (id: T) => void
  /** Middle-click and the like on a tab. */
  onItemAuxClick?: (id: T, event: React.MouseEvent<HTMLButtonElement>) => void
  onItemContextMenu?: (id: T, event: React.MouseEvent<HTMLButtonElement>) => void
}

export function Tabs<T extends string = string>({
  ariaLabel,
  items,
  value,
  onChange,
  idPrefix,
  className,
  borderless,
  onCloseItem,
  onItemAuxClick,
  onItemContextMenu,
}: TabsProps<T>) {
  const fallbackPrefix = useId()
  const prefix = idPrefix ?? fallbackPrefix
  const listRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const focusTabAt = useCallback(
    (index: number) => {
      if (!listRef.current) return
      const tabs = Array.from(
        listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
      )
      if (tabs.length === 0) return
      const wrapped = (index + tabs.length) % tabs.length
      tabs[wrapped]?.focus()
    },
    [],
  )

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (!target || target.getAttribute('role') !== 'tab') return
      const enabled = items.filter((item) => !item.disabled)
      const currentIndex = enabled.findIndex((item) => item.id === target.dataset.tabId)
      if (currentIndex === -1) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        const next = enabled[(currentIndex + 1) % enabled.length]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        const next = enabled[(currentIndex - 1 + enabled.length) % enabled.length]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'Home') {
        event.preventDefault()
        const next = enabled[0]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      } else if (event.key === 'End') {
        event.preventDefault()
        const next = enabled[enabled.length - 1]
        if (next) {
          onChange(next.id)
          focusTabAt(items.findIndex((item) => item.id === next.id))
        }
      }
    },
    [items, onChange, focusTabAt],
  )

  useEffect(() => {
    // Keep at most one tab in the tab order at any time; the active tab is the
    // one that participates in roving focus.
    if (!listRef.current) return
    const tabs = listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs.forEach((tab) => {
      tab.tabIndex = tab.dataset.tabId === valueRef.current ? 0 : -1
    })
  }, [value, items])

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={[
        'flex items-center gap-0.5',
        borderless ? '' : 'border-b border-[color:var(--border-default)]',
        className ?? '',
      ].filter(Boolean).join(' ')}
    >
      {items.map((item) => {
        const selected = item.id === value
        const tabId = `${prefix}-tab-${item.id}`
        const panelId = `${prefix}-panel-${item.id}`
        const iconNode =
          typeof item.icon === 'function'
            ? item.icon({ className: 'size-icon-xs shrink-0' })
            : item.icon
        const closable = Boolean(onCloseItem && item.closeLabel)
        const tab = (
          <button
            key={closable ? undefined : item.id}
            id={tabId}
            role="tab"
            type="button"
            data-tab-id={item.id}
            aria-selected={selected}
            aria-controls={panelId}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!item.disabled) onChange(item.id)
            }}
            onAuxClick={onItemAuxClick ? (event) => onItemAuxClick(item.id, event) : undefined}
            onContextMenu={onItemContextMenu ? (event) => onItemContextMenu(item.id, event) : undefined}
            className={[
              // `shrink-0 whitespace-nowrap`: a tab row in a narrow panel scrolls
              // inside its own overflow container rather than compressing its
              // labels — a flex child otherwise shrinks to fit its parent.
              'relative -mb-px inline-flex h-control-sm shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-meta',
              'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              // The close glyph sits in this reserved trailing padding, so
              // revealing it never reflows the label. A closable tab is a
              // document tab (a page title, a file), so it also caps its
              // width and truncates rather than letting one title own the row.
              closable ? 'max-w-[220px] pr-8' : '',
              selected
                ? 'text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            {iconNode ? <span aria-hidden="true" className="inline-flex">{iconNode}</span> : null}
            <span className={closable ? 'min-w-0 truncate' : undefined}>{item.label}</span>
            {item.count !== undefined ? (
              <span className="tabular-nums text-micro text-[color:var(--text-muted)]">
                {item.count}
              </span>
            ) : null}
            <span
              aria-hidden="true"
              className={[
                'absolute bottom-0 left-2 right-2 h-px',
                selected ? 'bg-[color:var(--accent-primary)]' : 'bg-transparent',
              ].join(' ')}
            />
          </button>
        )
        if (!closable) return tab
        return (
          <span key={item.id} className="group/tab relative inline-flex shrink-0">
            {tab}
            <button
              type="button"
              tabIndex={-1}
              aria-label={item.closeLabel}
              onClick={(event) => {
                event.stopPropagation()
                onCloseItem?.(item.id)
              }}
              className={[
                'absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm',
                'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                selected ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100',
                FOCUS_RING_CLASS,
              ].join(' ')}
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        )
      })}
    </div>
  )
}

type TabPanelProps = {
  /** Stable id prefix matching the parent Tabs. */
  idPrefix: string
  tabId: string
  active: boolean
  children: React.ReactNode
  className?: string
}

export function TabPanel({ idPrefix, tabId, active, children, className }: TabPanelProps) {
  if (!active) return null
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tabId}`}
      aria-labelledby={`${idPrefix}-tab-${tabId}`}
      // The panel is a focusable scroll container, so it is a tab stop and needs
      // a signal that the keyboard is driving the region. Without this it falls
      // back to Chromium's UA outline — the one treatment the design system
      // cannot theme. Inset, as the door listboxes already do, because the
      // indicator sits at the edge of a scrolling region.
      className={[className ?? '', FOCUS_RING_INSET_CLASS].filter(Boolean).join(' ')}
      tabIndex={0}
    >
      {children}
    </div>
  )
}
