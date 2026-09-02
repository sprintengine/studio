import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Popover } from './Popover'
import { MenuDivider, MenuSwatchRow, MenuFlyoutItem } from './ContextMenu'
import { Tooltip } from './Tooltip'
import { MENU_ITEM_CLASS, MENU_LIST_CLASS } from './menuClasses'
import { FOCUS_RING_CLASS } from './tokens'
import { TruncatedText } from './TruncatedText'
import type { HighlightColor } from '../../types/workspace'

export type OverflowMenuItem =
  | {
      kind?: 'item'
      id: string
      label: string
      onSelect: () => void
      disabled?: boolean
      /** Tone for destructive or warning items. Defaults to neutral. */
      destructive?: boolean
      /** Visible keyboard shortcut hint (e.g. `⌘ K`). Display only. */
      shortcut?: string
      /** Optional leading icon. */
      icon?: React.ReactNode
    }
  | { kind: 'separator'; id: string }
  | {
      // A color-swatch row (the shared MenuSwatchRow), for menus that also carry
      // an identity/highlight colour — e.g. an epic's colour on the Backlog
      // detail menu. Same swatches, clear control, and a11y as the right-click
      // menu, wired into this menu's arrow-key nav.
      kind: 'swatch'
      id: string
      label?: string
      value: HighlightColor | null
      onPick: (color: HighlightColor) => void
      onClear: () => void
    }
  | {
      // A flyout submenu (the shared MenuFlyoutItem), for menus that carry a
      // nested set of choices — e.g. the Backlog detail menu's Size/Priority/
      // Risk/Status editors. `render(close)` returns the flyout's MenuItem
      // children; each choice calls its setter then `close()` to dismiss the
      // whole overflow menu, matching how a flat item calls setOpen(false).
      kind: 'flyout'
      id: string
      label: string
      ariaLabel: string
      icon?: React.ReactNode
      disabled?: boolean
      surfaceClassName?: string
      /** Open-state notifications, e.g. to lazily refresh flyout content
       *  (mirrors MenuFlyoutItem's own prop). */
      onOpenChange?: (open: boolean) => void
      render: (close: () => void) => React.ReactNode
    }

// Buttons that participate in roving focus: this menu's own items plus any
// swatch buttons a MenuSwatchRow contributes (they carry data-menu-item).
const FOCUSABLE_SELECTOR =
  '[data-overflow-item="true"]:not([disabled]), [data-menu-item="true"]:not([disabled])'

type OverflowMenuProps = {
  /** Required accessible name (e.g. "Switchboard overflow"). */
  ariaLabel: string
  items: OverflowMenuItem[]
  /** Optional render for the trigger button; defaults to a kebab icon. */
  trigger?: (open: () => void, opened: boolean) => React.ReactNode
  /** Hover/focus tooltip for the default kebab trigger (e.g. "More actions"). */
  triggerTooltip?: string
  /** Horizontal alignment for the menu surface. */
  align?: 'start' | 'end'
}

const KEBAB = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="7" cy="3" r="1.2" fill="currentColor" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    <circle cx="7" cy="11" r="1.2" fill="currentColor" />
  </svg>
)

export function OverflowMenu({ ariaLabel, items, trigger, triggerTooltip, align = 'end' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLElement | null>(null)

  const interactiveItems = useMemo(
    () =>
      items.filter(
        (item) => item.kind !== 'separator' && item.kind !== 'swatch' && item.kind !== 'flyout',
      ) as Extract<OverflowMenuItem, { kind?: 'item' }>[],
    [items],
  )

  const focusFirstItem = useCallback((surface: HTMLElement) => {
    menuRef.current = surface
    const first = surface.querySelector<HTMLButtonElement>(FOCUSABLE_SELECTOR)
    first?.focus()
  }, [])

  const focusByOffset = (current: HTMLElement, offset: 1 | -1) => {
    if (!menuRef.current) return
    const nodes = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>(FOCUSABLE_SELECTOR))
    if (nodes.length === 0) return
    const idx = nodes.indexOf(current as HTMLButtonElement)
    const next = nodes[(idx + offset + nodes.length) % nodes.length]
    next?.focus()
  }

  const onItemKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusByOffset(event.currentTarget, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusByOffset(event.currentTarget, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      const first = menuRef.current?.querySelector<HTMLButtonElement>(FOCUSABLE_SELECTOR)
      first?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      const all = menuRef.current?.querySelectorAll<HTMLButtonElement>(FOCUSABLE_SELECTOR)
      all?.[all.length - 1]?.focus()
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement={align === 'end' ? 'bottom-end' : 'bottom-start'}
      // The shared list layer. `Popover` draws the chrome; this adds the menu's
      // own padding and type floor, so the kebab and the right-click menu are
      // the same surface reached two ways. Only the width floor is this host's.
      surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstItem}
      renderTrigger={({ ref, openPopover, open: opened, togglePopover, triggerProps }) => {
        const button = (
          <button
            ref={ref}
            type="button"
            aria-haspopup="menu"
            aria-expanded={triggerProps['aria-expanded']}
            aria-controls={triggerProps['aria-controls']}
            aria-label={ariaLabel}
            onClick={togglePopover}
            className={[
              'interactive inline-flex h-6 w-6 items-center justify-center rounded-sm',
              'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
              opened ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : '',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            {trigger ? trigger(openPopover, opened) : KEBAB}
          </button>
        )
        // A tooltip only makes sense on the default kebab; a custom trigger owns
        // its own affordance. Suppressed while the menu is open so it doesn't
        // linger over the surface.
        return triggerTooltip && !trigger && !opened ? (
          <Tooltip content={triggerTooltip} wrapperClassName="inline-flex">
            {button}
          </Tooltip>
        ) : (
          button
        )
      }}
    >
          {items.map((item) => {
            if (item.kind === 'separator') {
              return <MenuDivider key={item.id} />
            }
            if (item.kind === 'swatch') {
              return (
                <MenuSwatchRow
                  key={item.id}
                  label={item.label}
                  value={item.value}
                  onPick={item.onPick}
                  onClear={item.onClear}
                  onItemKeyDown={onItemKey}
                />
              )
            }
            if (item.kind === 'flyout') {
              return (
                <MenuFlyoutItem
                  key={item.id}
                  label={item.label}
                  ariaLabel={item.ariaLabel}
                  icon={item.icon}
                  disabled={item.disabled}
                  // No size pin. The flyout draws the shared menu surface, which
                  // carries the type size — a host that re-pins it is rebuilding
                  // the divergence the class pair exists to prevent.
                  surfaceClassName={item.surfaceClassName}
                  onItemKeyDown={onItemKey}
                  onOpenChange={item.onOpenChange}
                >
                  {item.render(() => setOpen(false))}
                </MenuFlyoutItem>
              )
            }
            const isFirst = item.id === interactiveItems[0]?.id
            return (
              <button
                key={item.id}
                role="menuitem"
                type="button"
                data-overflow-item="true"
                disabled={item.disabled}
                tabIndex={isFirst ? 0 : -1}
                onKeyDown={onItemKey}
                onClick={() => {
                  if (item.disabled) return
                  item.onSelect()
                  setOpen(false)
                }}
                className={[
                  MENU_ITEM_CLASS,
                  item.destructive
                    ? 'text-[color:var(--tone-error)]'
                    : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]',
                ].join(' ')}
              >
                {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                <TruncatedText as="span" text={item.label} className="min-w-0 flex-1" />
                {item.shortcut ? (
                  <span className="font-mono text-micro text-[color:var(--text-disabled)]">
                    {item.shortcut}
                  </span>
                ) : null}
              </button>
            )
          })}
    </Popover>
  )
}
