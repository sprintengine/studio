// The composer's buttons and its context menu.

import React from 'react'
import { PrimaryButton, IconButton, ContextMenu, MenuItem, MenuDivider } from '../../ui'

// Menu shortcut hints use the platform's own editing chords, so the composer
// menu teaches the keyboard path instead of inventing one.
export function editingShortcut(platform: string, key: string): string {
  return platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`
}

// Square composer action (30px): the accent-filled send, or a neutral stop
// while a turn streams. Built from the kit rather than by hand (2026-09-02
// audit, ruling 9): the send is the composer's ONE primary — `PrimaryButton`
// squared to the control-sm step — and the stop is the kit's 30px `IconButton`,
// so radius, focus ring, hover and the 45% disabled step all come from
// `Buttons.tsx` instead of a private recipe. The bordered `bg-hover` /
// `bg-active` neutral this used to draw was a fourth button variant.
export function ComposerActionButton({
  tone,
  ariaLabel,
  onClick,
  disabled,
  children,
}: {
  tone: 'accent' | 'neutral'
  ariaLabel: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  if (tone === 'accent') {
    return (
      <PrimaryButton
        size="sm"
        aria-label={ariaLabel}
        onClick={onClick}
        disabled={disabled}
        className="w-control-sm shrink-0"
      >
        {children}
      </PrimaryButton>
    )
  }
  return (
    <IconButton size="md" aria-label={ariaLabel} onClick={onClick} disabled={disabled} className="shrink-0">
      {children}
    </IconButton>
  )
}

// What the composer's right-click menu was opened over: the point to open at,
// the selection at the moment of the click (opening the menu moves focus off
// the field), and the clipboard text read for that open so Paste is enabled
// only when there is something to paste.
export type ComposerMenuState = {
  x: number
  y: number
  selectionStart: number
  selectionEnd: number
  clipboardText: string
}

// Right-click menu for the composer (1793). Send leads — it is the reason this
// menu exists and the action the surrounding field is for — with the standard
// editing actions below it. Send reads the same rule as the send button and
// Enter, so all three agree on when a turn commits and whether it queues.
export function ComposerContextMenu({
  menu,
  send,
  editable,
  onSend,
  onCut,
  onCopy,
  onPaste,
  onClose,
}: {
  menu: ComposerMenuState
  send: { label: string; disabled: boolean }
  editable: boolean
  onSend: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onClose: () => void
}) {
  const platform = typeof window !== 'undefined' ? (window.api?.platform ?? '') : ''
  const hasSelection = menu.selectionEnd > menu.selectionStart
  const run = (action: () => void) => () => {
    action()
    onClose()
  }
  return (
    <ContextMenu x={menu.x} y={menu.y} ariaLabel="Message actions" onClose={onClose} surfaceClassName="min-w-[200px]">
      <MenuItem disabled={send.disabled} shortcut="Enter" onClick={run(onSend)}>
        {send.label}
      </MenuItem>
      <MenuDivider />
      <MenuItem disabled={!editable || !hasSelection} shortcut={editingShortcut(platform, 'X')} onClick={run(onCut)}>
        Cut
      </MenuItem>
      <MenuItem disabled={!hasSelection} shortcut={editingShortcut(platform, 'C')} onClick={run(onCopy)}>
        Copy
      </MenuItem>
      <MenuItem
        disabled={!editable || menu.clipboardText === ''}
        shortcut={editingShortcut(platform, 'V')}
        onClick={run(onPaste)}
      >
        Paste
      </MenuItem>
    </ContextMenu>
  )
}
