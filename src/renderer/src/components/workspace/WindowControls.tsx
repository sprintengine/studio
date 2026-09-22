// Window-control buttons used by the WorkspaceManager titlebar on Windows /
// custom-frame builds. Extracted from WorkspaceManager.tsx so the orchestrator
// stays focused on layout coordination. Pure presentation: window state in,
// IPC calls out.

import React from 'react'
import { CaptionButton } from '../ui/Buttons'
import { Tooltip } from '../ui/Tooltip'

// The three caption buttons are `w-10` each, so this is the width of the strip
// they occupy. They float at the window's absolute top-right corner over
// whatever column owns that edge (WorkspaceManager), and there is no full-width
// bar to give them a seat — so the column that is under them has to leave this
// much of its own top row empty, or its right-hand controls sit under Close.
// Keep in step with the `w-10` on the buttons below.
const WINDOW_CONTROLS_WIDTH = 120

/**
 * The room a top strip leaves for the floating caption buttons on win/linux.
 * Zero on macOS, where the native traffic lights sit on the LEFT and the
 * right corner is free. Pass the result to `WindowCaptionReserve`.
 */
export function windowCaptionReserve(isMac: boolean): number {
  return isMac ? 0 : WINDOW_CONTROLS_WIDTH
}

/**
 * The empty slot a top strip renders at its trailing end so its own controls
 * stop short of the caption buttons. Renders nothing at width 0, so a strip can
 * mount it unconditionally and let the platform decide.
 */
/**
 * Whether the workspace pane's strip owns the window's top-right corner, the
 * one the win/linux caption buttons float over. Docked and open, the pane is
 * the rightmost column and its strip is the top band at that edge. Maximised it
 * is not: the filling column starts BELOW the 36px WorkspaceHeader
 * (workspaceAsideColumn), so the header runs to the window edge and the caption
 * buttons sit over the header's end. Reading only `open` here is what put the
 * header's pane switch under Close-window while the pane was maximised. Exactly
 * one of the two strips reserves the width: the header when this is false, the
 * pane strip when it is true.
 */
export function paneStripOwnsCaptionCorner(pane: { open: boolean; maximised: boolean }): boolean {
  return pane.open && !pane.maximised
}

export function WindowCaptionReserve({ width }: { width: number }) {
  if (width <= 0) return null
  return <div aria-hidden="true" className="shrink-0" style={{ width }} />
}

export function WindowControls({ isMaximized }: { isMaximized: boolean }) {
  const minimizeWindow = () => {
    void window.api.windowMinimize()
  }

  const toggleWindowSize = () => {
    void window.api.windowToggleMaximize()
  }

  const closeWindow = () => {
    void window.api.windowClose()
  }

  return (
    <div className="app-no-drag flex shrink-0 items-stretch" aria-label="Window controls">
      <Tooltip content="Minimize" placement="bottom">
        <CaptionButton onClick={minimizeWindow} aria-label="Minimize window">
          <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8H12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </CaptionButton>
      </Tooltip>

      <Tooltip content={isMaximized ? 'Restore' : 'Maximize'} placement="bottom">
        <CaptionButton onClick={toggleWindowSize} aria-label={isMaximized ? 'Restore window' : 'Maximize window'}>
          {isMaximized ? (
            <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 6.5H11.5V12.5H5.5V6.5Z" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M4.5 9.5H3.5V3.5H9.5V4.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4H12V12H4V4Z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </CaptionButton>
      </Tooltip>

      {/* `tone="close"` carries the Windows-native hover red, which now lives in
          the kit with its own design-tokens-allow. */}
      <Tooltip content="Close" placement="bottom">
        <CaptionButton tone="close" onClick={closeWindow} aria-label="Close window">
          <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </CaptionButton>
      </Tooltip>
    </div>
  )
}
