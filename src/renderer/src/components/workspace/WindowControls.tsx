// Window-control buttons used by the WorkspaceManager titlebar on Windows /
// custom-frame builds. Extracted from WorkspaceManager.tsx so the orchestrator
// stays focused on layout coordination. Pure presentation: window state in,
// IPC calls out.

import React from 'react'
import { Tooltip } from '../ui/Tooltip'
import { FOCUS_RING_CLASS } from '../ui/tokens'

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
        <button
          type="button"
          onClick={minimizeWindow}
          className={`inline-flex w-10 items-center justify-center text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:bg-[color:var(--bg-hover)] focus:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS} focus-visible:ring-inset`}
          aria-label="Minimize window"
        >
          <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8H12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>

      <Tooltip content={isMaximized ? 'Restore' : 'Maximize'} placement="bottom">
        <button
          type="button"
          onClick={toggleWindowSize}
          className={`inline-flex w-10 items-center justify-center text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:bg-[color:var(--bg-hover)] focus:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS} focus-visible:ring-inset`}
          aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        >
          {isMaximized ? (
            <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 6.5H11.5V12.5H5.5V6.5Z" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4.5 9.5H3.5V3.5H9.5V4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4H12V12H4V4Z" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
      </Tooltip>

      <Tooltip content="Close" placement="bottom">
        <button
          type="button"
          onClick={closeWindow}
          // design-tokens-allow: Windows 11 OS-native close-button hover red; tokenising would replace the system-expected red with the Multicode tone palette
          className={`inline-flex w-10 items-center justify-center text-[color:var(--text-muted)] transition-colors hover:bg-[#c42b1c] hover:text-white focus:bg-[#c42b1c] focus:text-white ${FOCUS_RING_CLASS} focus-visible:ring-inset`}
          aria-label="Close window"
        >
          <svg className="icon-sm" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  )
}
