import React from 'react'

import type { BrowserTabState } from '../../../../../../shared/browser'
import type { BrowserColorScheme } from '../../../../../../shared/browser-devices'
import { MenuItem, OverflowMenu, type OverflowMenuItem } from '../../../ui'

// The browser tab's ⋮ menu: the view actions that are not worth a glyph of
// their own. Rows are the shared menu vocabulary; the shortcut column carries
// only chords that work with the menu closed (the zoom chords do, from the
// guest or the toolbar).

type BrowserViewMenuProps = {
  state: BrowserTabState | null
  deviceToolbarOn: boolean
  onHardReload: () => void
  onOpenDevTools: () => void
  onOpenWindow: () => void
  onToggleDeviceToolbar: () => void
  onColorScheme: (scheme: BrowserColorScheme) => void
  onZoom: (direction: 1 | -1 | 0) => void
  onClearCookies: () => void
  onClearCache: () => void
}

const SCHEMES: { value: BrowserColorScheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function Tick() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BrowserViewMenu({
  state,
  deviceToolbarOn,
  onHardReload,
  onOpenDevTools,
  onOpenWindow,
  onToggleDeviceToolbar,
  onColorScheme,
  onZoom,
  onClearCookies,
  onClearCache,
}: BrowserViewMenuProps) {
  const hasPage = Boolean(state?.url && state.url !== 'about:blank')
  const primary = window.api.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const zoomPercent = Math.round((state?.zoomFactor ?? 1) * 100)
  const scheme = state?.colorScheme ?? 'system'

  const items: OverflowMenuItem[] = [
    { id: 'hard-reload', label: 'Hard reload', onSelect: onHardReload, disabled: !hasPage },
    {
      id: 'devtools',
      label: state?.devToolsOpen ? 'Focus DevTools' : 'Open DevTools',
      onSelect: onOpenDevTools,
      disabled: !hasPage,
    },
    { id: 'window', label: 'Open separate window', onSelect: onOpenWindow, disabled: !hasPage },
    {
      id: 'device-toolbar',
      label: deviceToolbarOn ? 'Hide device toolbar' : 'Show device toolbar',
      onSelect: onToggleDeviceToolbar,
    },
    {
      kind: 'flyout',
      id: 'appearance',
      label: 'Appearance',
      ariaLabel: 'Appearance',
      surfaceClassName: 'min-w-[140px]',
      render: (close) => (
        <>
          {SCHEMES.map((option) => (
            <MenuItem
              key={option.value}
              checked={scheme === option.value}
              selection="one-of"
              icon={scheme === option.value ? <Tick /> : <span className="inline-block size-[13px]" aria-hidden="true" />}
              onClick={() => {
                onColorScheme(option.value)
                close()
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </>
      ),
    },
    { kind: 'separator', id: 'zoom-separator' },
    { id: 'zoom-in', label: 'Zoom in', shortcut: `${primary}=`, onSelect: () => onZoom(1) },
    { id: 'zoom-out', label: 'Zoom out', shortcut: `${primary}-`, onSelect: () => onZoom(-1) },
    {
      id: 'zoom-reset',
      label: `Reset zoom · ${zoomPercent}%`,
      shortcut: `${primary}0`,
      onSelect: () => onZoom(0),
      disabled: zoomPercent === 100,
    },
    { kind: 'separator', id: 'storage-separator' },
    { id: 'clear-cookies', label: 'Clear cookies', onSelect: onClearCookies },
    { id: 'clear-cache', label: 'Clear cache', onSelect: onClearCache },
  ]

  return <OverflowMenu ariaLabel="Browser view" triggerTooltip="More" items={items} />
}
