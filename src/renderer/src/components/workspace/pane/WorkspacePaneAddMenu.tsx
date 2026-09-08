import React, { useCallback, useState } from 'react'

import { IconButton, MenuItem, Popover, Tooltip } from '../../ui'
import { MENU_LIST_CLASS } from '../../ui/menuClasses'
import type { PaneKindDefinition, PaneLaunchKind } from './paneKinds'

// The strip's "+": a menu of the kinds this workspace can open, each row with
// its glyph and the letter that opens it while the menu is showing. Rows are
// the shared menu vocabulary (design-system/components/menu); the letter hints
// are the trailing mono column the spec reserves for accelerators.

function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

type WorkspacePaneAddMenuProps = {
  kinds: readonly PaneKindDefinition[]
  onPick: (kind: PaneLaunchKind) => void
}

const MENU_ITEM_SELECTOR = '[role=menuitem]:not([disabled])'

export function WorkspacePaneAddMenu({ kinds, onPick }: WorkspacePaneAddMenuProps) {
  const [open, setOpen] = useState(false)

  const pick = useCallback(
    (kind: PaneLaunchKind) => {
      setOpen(false)
      onPick(kind)
    },
    [onPick],
  )

  // Arrow keys walk the rows (Escape is the popover's); a kind's letter opens
  // it without walking to it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const surface = event.currentTarget
    const rows = Array.from(surface.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR))
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      rows[(index + delta + rows.length) % rows.length]?.focus()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus()
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const letter = event.key.toUpperCase()
      const match = kinds.find((definition) => definition.letter === letter)
      if (match) {
        event.preventDefault()
        pick(match.kind)
      }
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Open in the pane"
      popupRole="menu"
      placement="bottom-end"
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="Open in the pane" placement="bottom">
          <IconButton
            ref={ref}
            onClick={togglePopover}
            aria-label="Open in the pane"
            pressed={open}
            className="app-no-drag"
            {...triggerProps}
          >
            <PlusGlyph className="icon-sm" />
          </IconButton>
        </Tooltip>
      )}
    >
      <div className={`w-[200px] ${MENU_LIST_CLASS}`} onKeyDown={onKeyDown}>
        {kinds.map(({ kind, label, letter, Glyph }) => (
          // The kit's menu item, which is what `MENU_ITEM_CLASS` was standing in
          // for here. The letter rides `trailing` rather than `shortcut`: the
          // hint is decoration the row's own key handler acts on, so it stays
          // `aria-hidden` and out of the row's accessible name, which the
          // shortcut slot would not do.
          <MenuItem
            key={kind}
            onClick={() => pick(kind)}
            icon={<Glyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />}
            trailing={
              <span aria-hidden="true" className="font-mono text-micro text-[color:var(--text-disabled)]">
                {letter}
              </span>
            }
          >
            {label}
          </MenuItem>
        ))}
      </div>
    </Popover>
  )
}
