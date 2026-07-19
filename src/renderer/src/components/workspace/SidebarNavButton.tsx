import React from 'react'

import { FOCUS_RING_CLASS } from '../ui/tokens'
import { Tooltip } from '../ui/Tooltip'

// Top-nav row (New chat, Automations, Sprints, Connectors, and module-contributed
// doors like Roadmap). One quiet muted row that lights to the canonical selected
// fill when active; the collapsed rail shows the icon with a hover tooltip
// carrying the label. An optional `indicator` (a status dot) rides the trailing
// edge when expanded, or the top-right corner when collapsed.
//
// Extracted from WorkspaceSidebar so the sidebar-nav host contribution point
// (renderer-host.ts) can render module doors with the same chrome as the shell's
// own doors — a module entry is just a component that renders one of these.
export function SidebarNavButton({
  collapsed,
  active,
  dropActive,
  label,
  ariaLabel,
  tooltip,
  tooltipWhenExpanded,
  indicator,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  icon,
}: {
  collapsed: boolean
  active?: boolean
  // Transient drop-target highlight (e.g. tab-extract); styled like `active`
  // but without claiming aria-current, since it is not a persistent selection.
  dropActive?: boolean
  label: string
  ariaLabel: string
  tooltip: string
  // Show the tooltip in the expanded state too, not only when collapsed —
  // used to surface an accelerator/drop hint the visible label omits.
  tooltipWhenExpanded?: boolean
  // A small state dot (running / waiting-on-you), trailing when expanded and a
  // corner dot when collapsed. Its own aria-label carries the meaning.
  indicator?: React.ReactNode
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>) => void
  onDragLeave?: (event: React.DragEvent<HTMLButtonElement>) => void
  onDrop?: (event: React.DragEvent<HTMLButtonElement>) => void
  icon: React.ReactNode
}) {
  const highlighted = Boolean(active) || Boolean(dropActive)
  const button = (
    <button
      type="button"
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-current={active ? 'true' : undefined}
      aria-label={collapsed ? ariaLabel : undefined}
      className={`relative flex h-[30px] w-full items-center rounded-md text-[12px] font-medium transition-colors ${FOCUS_RING_CLASS} ${
        collapsed ? 'justify-center' : 'gap-2 px-2 text-left'
      } ${
        highlighted
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {icon}
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
      {indicator ? (
        collapsed ? (
          <span className="absolute right-1 top-1 flex">{indicator}</span>
        ) : (
          <span className="ml-auto flex shrink-0 pl-1">{indicator}</span>
        )
      ) : null}
    </button>
  )
  if (collapsed) {
    return (
      <Tooltip content={tooltip} placement="right" wrapperClassName="flex">
        {button}
      </Tooltip>
    )
  }
  if (tooltipWhenExpanded) {
    // `right` (matching the collapsed rail) keeps the tip beside the row over the
    // content column. The default `top` sent the topmost row's (New Agent) tip up
    // into the macOS traffic-light zone, where the viewport clamp pinned it to the
    // window's top-left corner.
    return (
      <Tooltip content={tooltip} placement="right" wrapperClassName="flex">
        {button}
      </Tooltip>
    )
  }
  return button
}
