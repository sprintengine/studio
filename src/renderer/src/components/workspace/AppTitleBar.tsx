// The app-wide title strip across the top of the window. It carries the
// centered Multicode brand (Discord-style) and the platform window chrome:
// native traffic lights inset on the left on macOS, custom menu + window
// controls on the custom-frame builds. The whole strip is a drag region; the
// brand is pointer-transparent so it never eats a drag, and only the menu /
// control clusters opt back out with `app-no-drag`.

import React from 'react'
import MulticodeMark from '../brand/MulticodeMark'
import { WindowControls } from './WindowControls'

const TITLE_BAR_HEIGHT = 'h-[36px]'

// macOS reserves the leftmost slice for the native traffic lights; pad the
// menu/brand flow past them so nothing sits under the close/zoom buttons.
const TRAFFIC_LIGHT_INSET = 'pl-[78px]'

type AppTitleBarProps<MenuItem extends string> = {
  isMac: boolean
  isMaximized: boolean
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
}

export function AppTitleBar<MenuItem extends string>({
  isMac,
  isMaximized,
  menuItems,
  onShowMenu,
}: AppTitleBarProps<MenuItem>) {
  return (
    <div
      className={`app-drag relative flex ${TITLE_BAR_HEIGHT} shrink-0 items-stretch justify-between border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]`}
    >
      {/* Centered brand. Pointer-transparent so the strip stays draggable. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight text-[color:var(--text-default)]">
          <MulticodeMark className="h-[15px] w-[15px]" />
          <span>multicode</span>
        </span>
      </div>

      {isMac ? (
        // Spacer holds the traffic-light gutter; the centered brand floats above.
        <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} />
      ) : (
        <>
          <div className="relative z-10 flex min-w-0 items-center gap-1 px-2">
            {menuItems.map((label) => (
              <button
                key={label}
                type="button"
                onClick={(event) => onShowMenu(event, label)}
                className="app-no-drag inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative z-10">
            <WindowControls isMaximized={isMaximized} />
          </div>
        </>
      )}
    </div>
  )
}
