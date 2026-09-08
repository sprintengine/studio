import React from 'react'

import { Badge } from '../ui/Badge'
import { RowButton } from '../ui/RowButton'
import type { Tone } from '../ui/tokens'
import { Tooltip } from '../ui/Tooltip'

// Top-nav row (New chat, Automations, Sprints, Connectors, and any door a
// capability module contributes). One quiet muted row that lights to the canonical selected
// fill when active; the collapsed rail shows the icon with a hover tooltip
// carrying the label. An optional `indicator` (a status dot) rides the trailing
// edge when expanded, or the top-right corner when collapsed.
//
// A `badge` (owner, 2026-09-08) is the row's unread count: the kit's corner
// counter for unread activity — trailing when the row is expanded,
// docked on the icon's corner when collapsed, the same way the app rail's
// squares wear theirs. It REPLACES the indicator while it shows: a count and a
// dot on one row would be two status idioms saying one thing, which
// principles.md rejects on sight, and the count is the one that says how much.
//
// Extracted from WorkspaceSidebar so the sidebar-nav host contribution point
// (renderer-host.ts) can render module doors with the same chrome as the shell's
// own doors — a module entry is just a component that renders one of these.

/** A row's unread count. Null or a zero draws nothing — a badge never says 0. */
export type RowBadge = {
  count: number
  tone: Tone
  /** The count's accessible name; a bare number tells a screen reader nothing. */
  label: string
}

export function SidebarNavButton({
  collapsed,
  active,
  dropActive,
  label,
  ariaLabel,
  tooltip,
  tooltipWhenExpanded,
  indicator,
  badge,
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
  // The row's unread count, drawn in place of `indicator` while it is above 0.
  badge?: RowBadge | null
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>) => void
  onDragLeave?: (event: React.DragEvent<HTMLButtonElement>) => void
  onDrop?: (event: React.DragEvent<HTMLButtonElement>) => void
  icon: React.ReactNode
}) {
  const highlighted = Boolean(active) || Boolean(dropActive)
  const button = (
    // The kit's row at the sidebar's navigation rhythm. `selected` paints the
    // canonical selection — the neutral fill plus the 2px inset edge every other
    // chosen row in the product draws — for BOTH the active door and the
    // transient drop target, while the explicit `aria-current` after it keeps a
    // drop highlight out of the navigation state (it is a hover, not a place).
    // The type stays here because `RowButton` deliberately spells none.
    <RowButton
      density="nav"
      selected={highlighted}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-current={active ? 'true' : undefined}
      aria-label={collapsed ? ariaLabel : undefined}
      className={`relative text-heading font-medium ${collapsed ? 'justify-center' : ''}`}
    >
      {icon}
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
      {badge && badge.count > 0 ? (
        collapsed ? (
          // Docked on the row's own corner (the row is `relative`), ringed in
          // the sidebar's ground — `bg.canvas`, the same ground the rail's
          // squares sit on — rather than the app ground the primitive assumes.
          <Badge
            corner
            tone={badge.tone}
            count={badge.count}
            max={99}
            ariaLabel={badge.label}
            className="border-[color:var(--bg-canvas)]"
          />
        ) : (
          <span className="ml-auto flex shrink-0 pl-1">
            <Badge tone={badge.tone} count={badge.count} max={99} ariaLabel={badge.label} />
          </span>
        )
      ) : indicator ? (
        collapsed ? (
          <span className="absolute right-1 top-1 flex">{indicator}</span>
        ) : (
          <span className="ml-auto flex shrink-0 pl-1">{indicator}</span>
        )
      ) : null}
    </RowButton>
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
