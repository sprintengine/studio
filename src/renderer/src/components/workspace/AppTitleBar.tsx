// The app-wide title strip across the top of the window. It carries the
// centered Multicode brand (Discord-style) and the platform window chrome:
// native traffic lights inset on the left on macOS, custom menu + window
// controls on the custom-frame builds. The whole strip is a drag region; the
// brand is pointer-transparent so it never eats a drag, and only the menu /
// control clusters opt back out with `app-no-drag`.
//
// The right edge is the home for app-level (cross-workspace) surface toggles —
// today the Sprint Engines aside — matching the common "secondary
// side bar" idiom: a global panel gets a global toggle, never a slot in the
// per-workspace PanelRail.

import React from 'react'
import MulticodeMark from '../brand/MulticodeMark'
import { Tooltip } from '../ui'
import { AttentionQueuePopover, type AttentionQueueSurface } from './AttentionQueuePopover'
import { WindowControls } from './WindowControls'

const TITLE_BAR_HEIGHT = 'h-[36px]'

// macOS reserves the leftmost slice for the native traffic lights; pad the
// menu/brand flow past them so nothing sits under the close/zoom buttons.
const TRAFFIC_LIGHT_INSET = 'pl-[78px]'

type SprintEnginesToggle = {
  open: boolean
  onToggle: () => void
}

type AppTitleBarProps<MenuItem extends string> = {
  isMac: boolean
  isMaximized: boolean
  menuItems: readonly MenuItem[]
  onShowMenu: (event: React.MouseEvent<HTMLButtonElement>, label: MenuItem) => void
  // Null when the sprint-engine module is disabled — the toggle hides entirely.
  sprintEnginesToggle: SprintEnginesToggle | null
  // Cross-workspace "agents awaiting you" surface. Core shell chrome (no module
  // gate), so always present; WorkspaceManager owns its data + open state and the
  // title bar only places it — it adds no session/workspace subscription itself.
  attentionQueue: AttentionQueueSurface
  // Null outside dev/diagnostics builds — the performance panel is an
  // engineering tool, so its title-bar entry only exists when diagnostics are on.
  onOpenDiagnostics: (() => void) | null
}

function DiagnosticsTitleBarButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip content="Performance diagnostics" placement="bottom">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open performance diagnostics"
        className="app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
      >
        {/* Activity / pulse glyph. */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d="M1 8h3l2-4.5L9.5 13 12 8h3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </Tooltip>
  )
}

function SprintEnginesAsideToggle({ open, onToggle }: SprintEnginesToggle) {
  return (
    <Tooltip content="Sprint Engines" placement="bottom">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Toggle Sprint Engines"
        className={`app-no-drag interactive inline-flex h-7 w-7 items-center justify-center bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
          open
            ? 'text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'
        }`}
      >
        {/* `panel-right` mirror of the sidebar's panel-left collapse glyph. */}
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </Tooltip>
  )
}

export function AppTitleBar<MenuItem extends string>({
  isMac,
  isMaximized,
  menuItems,
  onShowMenu,
  sprintEnginesToggle,
  attentionQueue,
  onOpenDiagnostics,
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
        <>
          {/* Spacer holds the traffic-light gutter; the centered brand floats above. */}
          <div aria-hidden="true" className={TRAFFIC_LIGHT_INSET} />
          <div className="relative z-10 flex items-center gap-0.5 px-1.5">
            {onOpenDiagnostics ? <DiagnosticsTitleBarButton onOpen={onOpenDiagnostics} /> : null}
            <AttentionQueuePopover {...attentionQueue} />
            {sprintEnginesToggle ? <SprintEnginesAsideToggle {...sprintEnginesToggle} /> : null}
          </div>
        </>
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

          <div className="relative z-10 flex items-center">
            <div className="flex items-center gap-0.5 px-1">
              {onOpenDiagnostics ? <DiagnosticsTitleBarButton onOpen={onOpenDiagnostics} /> : null}
              <AttentionQueuePopover {...attentionQueue} />
              {sprintEnginesToggle ? <SprintEnginesAsideToggle {...sprintEnginesToggle} /> : null}
            </div>
            <WindowControls isMaximized={isMaximized} />
          </div>
        </>
      )}
    </div>
  )
}
