import React, { useRef, useState } from 'react'

import { MenuItem, Popover, Tooltip, ToolbarButton, TourGlyph, roveMenuFocus } from '../../ui'
import { MENU_LIST_CLASS } from '../../ui/menuClasses'
import { useRecentTours } from './useTourSession'

// The toolbar's way back into a tour: this workspace's recent tours, newest
// first. Read when the menu opens and not before — a diff opened for a file
// makes no tour call at all.

function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

export function TourMenu({
  workspaceId,
  currentTourId,
  onOpen,
}: {
  workspaceId: string
  currentTourId: string | null
  onOpen: (tourId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tours = useRecentTours(workspaceId, open)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const now = Date.now()
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Recent tours"
      popupRole="menu"
      placement="bottom-end"
      onOpenAutoFocus={(surface) => {
        surfaceRef.current = surface
        surface.querySelector<HTMLButtonElement>('[data-menu-item="true"]')?.focus()
      }}
      surfaceClassName={`min-w-[20rem] max-w-[26rem] ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, togglePopover }) => (
        <Tooltip content="Tours" placement="bottom">
          <ToolbarButton ref={ref} ariaLabel="Tours" menu expanded={open} onClick={togglePopover}>
            <TourGlyph />
          </ToolbarButton>
        </Tooltip>
      )}
    >
      {tours.length === 0 ? (
        <MenuItem disabled onClick={() => {}}>
          No tours yet
        </MenuItem>
      ) : (
        tours.map((tour) => (
          <MenuItem
            key={tour.id}
            checked={tour.id === currentTourId}
            selection="one-of"
            hint={`${tour.stepCount} ${tour.stepCount === 1 ? 'step' : 'steps'}${tour.authorName ? ` · ${tour.authorName}` : ''} · ${ago(tour.updatedAt, now)}${tour.closed ? ' · closed' : ''}`}
            onClick={() => {
              setOpen(false)
              onOpen(tour.id)
            }}
            onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
          >
            {tour.title}
          </MenuItem>
        ))
      )}
    </Popover>
  )
}
