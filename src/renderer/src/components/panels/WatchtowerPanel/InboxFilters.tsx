import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { BackGlyph, CheckboxGlyph, ChevronGlyph, CrossGlyph, FilterGlyph, RadioGlyph } from './glyphs'
import {
  FOCUS_RING_CLASS,
  GhostButton,
  IconButton,
  InboxSearchInput,
  MENU_LIST_CLASS,
  MenuDivider,
  MenuItem,
  Popover,
  roveMenuFocus,
  Tooltip,
} from '../../ui'
import { WATCHTOWER_REVIEW_SECTORS, getWatchtowerReviewSector } from '../../../utils/watchtowerReview'
import { EMPTY_INBOX_FILTERS, INBOX_CREATED_RANGES, getInboxCreatedRange, hasActiveInboxFilters, type InboxCreatedRangeId, type InboxFilters } from '../../../utils/watchtower'
import type { WatchtowerReviewSectorId } from '../../../types/workspace'

type FilterStep = 'root' | 'sectors' | 'created'

export function InboxFilterBar({
  filters,
  onChange,
  sectorCounts,
}: {
  filters: InboxFilters
  onChange: (next: InboxFilters) => void
  sectorCounts: Map<WatchtowerReviewSectorId, number>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState<FilterStep>('root')
  const [chipOpen, setChipOpen] = useState<'sectors' | 'created' | null>(null)
  const filtersActive = hasActiveInboxFilters(filters)

  const openPicker = useCallback((step: FilterStep) => {
    setPickerStep(step)
    setPickerOpen(true)
  }, [])

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setPickerStep('root')
  }, [])

  const updateSearch = useCallback(
    (value: string) => onChange({ ...filters, search: value }),
    [filters, onChange]
  )
  const toggleSector = useCallback(
    (sector: WatchtowerReviewSectorId) => {
      const exists = filters.sectors.includes(sector)
      onChange({
        ...filters,
        sectors: exists ? filters.sectors.filter((id) => id !== sector) : [...filters.sectors, sector],
      })
    },
    [filters, onChange]
  )
  const setCreated = useCallback(
    (next: InboxCreatedRangeId | null) => onChange({ ...filters, createdRange: next }),
    [filters, onChange]
  )
  const clearAll = useCallback(() => onChange(EMPTY_INBOX_FILTERS), [onChange])

  const sectorChipLabel = useMemo(() => {
    if (filters.sectors.length === 0) return null
    if (filters.sectors.length === 1) return getWatchtowerReviewSector(filters.sectors[0]).label
    return `${getWatchtowerReviewSector(filters.sectors[0]).label} +${filters.sectors.length - 1}`
  }, [filters.sectors])

  const sectorCountsList = useMemo(
    () =>
      WATCHTOWER_REVIEW_SECTORS.map((sector) => ({
        sector,
        count: sectorCounts.get(sector.id) ?? 0,
      })).filter((entry) => entry.count > 0),
    [sectorCounts]
  )

  const hasChips = filters.sectors.length > 0 || filters.createdRange !== null

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
      <div className="flex items-center gap-2">
        <InboxSearchInput
          value={filters.search}
          onChange={updateSearch}
          ariaLabel="Search inbox"
        />
        <Popover
          open={pickerOpen}
          onOpenChange={(next) => (next ? openPicker('root') : closePicker())}
          ariaLabel="Add inbox filter"
          popupRole="menu"
          placement="bottom-end"
          surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
          renderTrigger={({ ref, triggerProps }) => (
            <Tooltip content="Filter">
              <button
                ref={ref}
                type="button"
                {...triggerProps}
                onClick={() => (pickerOpen ? closePicker() : openPicker('root'))}
                aria-label="Filter inbox"
                className={[
                  'interactive inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-dashed',
                  'border-[color:var(--border-default)] bg-transparent',
                  'text-[color:var(--text-muted)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)]',
                  FOCUS_RING_CLASS,
                ].join(' ')}
              >
                <FilterGlyph />
              </button>
            </Tooltip>
          )}
        >
          {pickerStep === 'root' ? (
            <FilterRootMenu
              hasSectors={sectorCountsList.length > 0}
              onPickSectors={() => setPickerStep('sectors')}
              onPickCreated={() => setPickerStep('created')}
            />
          ) : pickerStep === 'sectors' ? (
            <SectorPicker
              sectors={sectorCountsList}
              selected={filters.sectors}
              onToggle={toggleSector}
              onBack={() => setPickerStep('root')}
              onClear={() => onChange({ ...filters, sectors: [] })}
            />
          ) : (
            <CreatedPicker
              value={filters.createdRange}
              onChange={(next) => {
                setCreated(next)
                closePicker()
              }}
              onBack={() => setPickerStep('root')}
              onClear={() => {
                setCreated(null)
                closePicker()
              }}
            />
          )}
        </Popover>
      </div>

      {hasChips ? (
        <div className="flex flex-wrap items-center gap-2">
          {filters.sectors.length > 0 ? (
            <FilterChip
              label="Type"
              value={sectorChipLabel ?? ''}
              open={chipOpen === 'sectors'}
              onOpenChange={(open) => setChipOpen(open ? 'sectors' : null)}
              onRemove={() => onChange({ ...filters, sectors: [] })}
              removeAriaLabel="Remove type filter"
            >
              <SectorPicker
                sectors={sectorCountsList}
                selected={filters.sectors}
                onToggle={toggleSector}
                onClear={() => {
                  onChange({ ...filters, sectors: [] })
                  setChipOpen(null)
                }}
              />
            </FilterChip>
          ) : null}

          {filters.createdRange ? (
            <FilterChip
              label="Created"
              value={getInboxCreatedRange(filters.createdRange).label}
              open={chipOpen === 'created'}
              onOpenChange={(open) => setChipOpen(open ? 'created' : null)}
              onRemove={() => setCreated(null)}
              removeAriaLabel="Remove created filter"
            >
              <CreatedPicker
                value={filters.createdRange}
                onChange={(next) => {
                  setCreated(next)
                  setChipOpen(null)
                }}
                onClear={() => {
                  setCreated(null)
                  setChipOpen(null)
                }}
              />
            </FilterChip>
          ) : null}

          {filtersActive ? (
            <GhostButton onClick={clearAll} aria-label="Clear all inbox filters" className="ml-auto">
              Clear all
            </GhostButton>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// Every picker below is a list of the kit's menu rows on the Popover's own
// `role="menu"` surface. Arrow keys, Home and End rove through `roveMenuFocus`;
// focus lands on the first row when a step mounts (the root step, or a drill-in
// that replaced the row just pressed); and space — never a rule — separates the
// header, the rows and the clear action inside the overlay.
function useMenuStep(): {
  ref: RefObject<HTMLDivElement>
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
} {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Next frame: the Popover positions its surface in a layout effect and
    // keeps it `visibility: hidden` until then, and a hidden node cannot take
    // focus.
    const frame = requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    roveMenuFocus(event, event.currentTarget.closest<HTMLElement>('[role="menu"]'))
  }, [])
  return { ref, onKeyDown }
}

function FilterRootMenu({
  hasSectors,
  onPickSectors,
  onPickCreated,
}: {
  hasSectors: boolean
  onPickSectors: () => void
  onPickCreated: () => void
}) {
  const step = useMenuStep()
  return (
    <div ref={step.ref} onKeyDown={step.onKeyDown}>
      <MenuItem onClick={onPickSectors} disabled={!hasSectors} trailing={<ChevronGlyph />}>
        Review type
      </MenuItem>
      <MenuItem onClick={onPickCreated} trailing={<ChevronGlyph />}>
        Created
      </MenuItem>
    </div>
  )
}

function SectorPicker({
  sectors,
  selected,
  onToggle,
  onBack,
  onClear,
}: {
  sectors: Array<{ sector: { id: WatchtowerReviewSectorId; label: string }; count: number }>
  selected: WatchtowerReviewSectorId[]
  onToggle: (sector: WatchtowerReviewSectorId) => void
  onBack?: () => void
  onClear: () => void
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const step = useMenuStep()
  return (
    <div ref={step.ref} onKeyDown={step.onKeyDown} className="min-w-[220px]">
      {onBack ? <PickerHeader title="Review type" onBack={onBack} /> : null}
      <div className="max-h-[260px] overflow-y-auto">
        {sectors.map(({ sector, count }) => {
          const checked = selectedSet.has(sector.id)
          return (
            <MenuItem
              key={sector.id}
              checked={checked}
              onClick={() => onToggle(sector.id)}
              icon={<CheckboxGlyph checked={checked} />}
              trailing={<span className="shrink-0 tabular-nums text-micro text-[color:var(--text-muted)]">{count}</span>}
            >
              {sector.label}
            </MenuItem>
          )
        })}
      </div>
      {selected.length > 0 ? (
        <>
          <MenuDivider />
          <MenuItem onClick={onClear}>Clear selection</MenuItem>
        </>
      ) : null}
    </div>
  )
}

function CreatedPicker({
  value,
  onChange,
  onBack,
  onClear,
}: {
  value: InboxCreatedRangeId | null
  onChange: (next: InboxCreatedRangeId) => void
  onBack?: () => void
  onClear: () => void
}) {
  const step = useMenuStep()
  return (
    <div ref={step.ref} onKeyDown={step.onKeyDown} className="min-w-[180px]">
      {onBack ? <PickerHeader title="Created" onBack={onBack} /> : null}
      {INBOX_CREATED_RANGES.map((range) => {
        const active = value === range.id
        return (
          <MenuItem
            key={range.id}
            selection="one-of"
            checked={active}
            onClick={() => onChange(range.id)}
            icon={<RadioGlyph active={active} />}
          >
            {range.label}
          </MenuItem>
        )
      })}
      {value ? (
        <>
          <MenuDivider />
          <MenuItem onClick={onClear}>Clear selection</MenuItem>
        </>
      ) : null}
    </div>
  )
}

function PickerHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <IconButton aria-label="Back to filters" onClick={onBack}>
        <BackGlyph />
      </IconButton>
      <span className="text-meta font-medium text-[color:var(--text-strong)]">{title}</span>
    </div>
  )
}

function FilterChip({
  label,
  value,
  open,
  onOpenChange,
  onRemove,
  removeAriaLabel,
  children,
}: {
  label: string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  removeAriaLabel: string
  children: ReactNode
}) {
  return (
    <span className="inline-flex h-7 items-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-meta">
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel={`Edit ${label.toLowerCase()} filter`}
        popupRole="menu"
        surfaceClassName={MENU_LIST_CLASS}
        renderTrigger={({ ref, triggerProps }) => (
          <button
            ref={ref}
            type="button"
            {...triggerProps}
            onClick={() => onOpenChange(!open)}
            className={[
              'inline-flex h-full items-center gap-1.5 rounded-l-sm px-2',
              'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            <span className="text-[color:var(--text-muted)]">{label}</span>
            <span className="font-medium">{value}</span>
          </button>
        )}
      >
        {children}
      </Popover>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeAriaLabel}
        className={[
          'inline-flex h-full items-center justify-center rounded-r-sm border-l border-[color:var(--border-default)] px-1.5',
          'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        <CrossGlyph />
      </button>
    </span>
  )
}

