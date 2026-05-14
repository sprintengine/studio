import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FOCUS_RING_CLASS } from './tokens'

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

type OverflowMenuProps = {
  /** Required accessible name (e.g. "Switchboard overflow"). */
  ariaLabel: string
  items: OverflowMenuItem[]
  /** Optional render for the trigger button; defaults to a kebab icon. */
  trigger?: (open: () => void, opened: boolean) => React.ReactNode
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

export function OverflowMenu({ ariaLabel, items, trigger, align = 'end' }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const interactiveItems = useMemo(
    () => items.filter((item) => item.kind !== 'separator') as Extract<OverflowMenuItem, { kind?: 'item' }>[],
    [items],
  )

  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[data-overflow-item="true"]:not([disabled])')
    first?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const focusByOffset = (current: HTMLElement, offset: 1 | -1) => {
    if (!menuRef.current) return
    const nodes = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>('[data-overflow-item="true"]:not([disabled])'),
    )
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
      const first = menuRef.current?.querySelector<HTMLButtonElement>(
        '[data-overflow-item="true"]:not([disabled])',
      )
      first?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      const all = menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-overflow-item="true"]:not([disabled])',
      )
      all?.[all.length - 1]?.focus()
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={[
          'interactive inline-flex h-6 w-6 items-center justify-center rounded-[5px]',
          'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          open ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : '',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        {trigger ? trigger(() => setOpen(true), open) : KEBAB}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          className={[
            // design-tokens-allow: canonical popover elevation; the shadow on the next line is the reference implementation other popovers reuse via markers
            'popover-enter absolute z-30 mt-1 min-w-[200px] rounded-[7px] border border-[color:var(--border-strong)]',
            'bg-[color:var(--bg-surface-raised)] py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]',
            align === 'end' ? 'right-0' : 'left-0',
            'top-full',
          ].join(' ')}
        >
          {items.map((item) => {
            if (item.kind === 'separator') {
              return (
                <div
                  key={item.id}
                  role="separator"
                  className="my-1 h-px bg-[color:var(--border-default)]"
                />
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
                  close(false)
                }}
                className={[
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]',
                  'disabled:cursor-not-allowed disabled:opacity-45',
                  'hover:bg-[color:var(--bg-hover)]',
                  item.destructive
                    ? 'text-[color:var(--tone-error)]'
                    : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]',
                  FOCUS_RING_CLASS,
                ].join(' ')}
              >
                {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.shortcut ? (
                  <span className="font-mono text-[11px] text-[color:var(--text-disabled)]">
                    {item.shortcut}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
