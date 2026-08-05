import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { BackGlyph, CheckboxGlyph, ChevronGlyph, CrossGlyph, FilterGlyph, RadioGlyph } from './glyphs'
import { FOCUS_RING_CLASS, GhostButton, InboxSearchInput, Popover, Tooltip } from '../../ui'
import { MENU_ITEM_CLASS } from '../../ui/menuClasses'
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
          surfaceClassName="min-w-[200px] py-1"
          renderTrigger={({ ref, triggerProps }) => (
            <Tooltip content="Filter">
              <button
                ref={ref}
                type="button"
                {...triggerProps}
                onClick={() => (pickerOpen ? closePicker() : openPicker('root'))}
                aria-label="Filter inbox"
                className={[
                  'interactive inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] border border-dashed',
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

function FilterRootMenu({
  hasSectors,
  onPickSectors,
  onPickCreated,
}: {
  hasSectors: boolean
  onPickSectors: () => void
  onPickCreated: () => void
}) {
  return (
    <ul role="none" className="text-meta">
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={onPickSectors}
          disabled={!hasSectors}
          // The shared menu row (MC-2103) — a verbatim re-type of its content
          // drifts the moment the canon moves (ripple review, 2026-08-05).
          className={[
            MENU_ITEM_CLASS,
            'justify-between',
            'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]',
          ].join(' ')}
        >
          <span>Review type</span>
          <ChevronGlyph />
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          onClick={onPickCreated}
          className={`${MENU_ITEM_CLASS} justify-between text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
        >
          <span>Created</span>
          <ChevronGlyph />
        </button>
      </li>
    </ul>
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
  return (
    <div className="min-w-[220px] py-1 text-meta">
      {onBack ? <PickerHeader title="Review type" onBack={onBack} /> : null}
      <ul role="menu" className="max-h-[260px] overflow-y-auto">
        {sectors.map(({ sector, count }) => {
          const checked = selectedSet.has(sector.id)
          return (
            <li key={sector.id} role="none">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => onToggle(sector.id)}
                className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
              >
                <CheckboxGlyph checked={checked} />
                <span className="min-w-0 flex-1 truncate">{sector.label}</span>
                <span className="shrink-0 tabular-nums text-micro text-[color:var(--text-muted)]">{count}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {selected.length > 0 ? (
        <div className="border-t border-[color:var(--border-default)] px-1 pt-1">
          <button
            type="button"
            onClick={onClear}
            className="w-full rounded-[5px] px-2 py-1.5 text-left text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Clear selection
          </button>
        </div>
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
  return (
    <div className="min-w-[180px] py-1 text-meta">
      {onBack ? <PickerHeader title="Created" onBack={onBack} /> : null}
      <ul role="menu">
        {INBOX_CREATED_RANGES.map((range) => {
          const active = value === range.id
          return (
            <li key={range.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => onChange(range.id)}
                className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`}
              >
                <RadioGlyph active={active} />
                <span className="min-w-0 flex-1 truncate">{range.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {value ? (
        <div className="border-t border-[color:var(--border-default)] px-1 pt-1">
          <button
            type="button"
            onClick={onClear}
            className="w-full rounded-[5px] px-2 py-1.5 text-left text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Clear selection
          </button>
        </div>
      ) : null}
    </div>
  )
}

function PickerHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-[color:var(--border-default)] px-2 py-1.5">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to filters"
        className="shrink-0 text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]"
      >
        <BackGlyph />
      </button>
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
    <span className="inline-flex h-7 items-center rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-meta">
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel={`Edit ${label.toLowerCase()} filter`}
        popupRole="menu"
        surfaceClassName="py-0"
        renderTrigger={({ ref, triggerProps }) => (
          <button
            ref={ref}
            type="button"
            {...triggerProps}
            onClick={() => onOpenChange(!open)}
            className={[
              'inline-flex h-full items-center gap-1.5 rounded-l-[5px] px-2',
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
          'inline-flex h-full items-center justify-center rounded-r-[5px] border-l border-[color:var(--border-default)] px-1.5',
          'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        <CrossGlyph />
      </button>
    </span>
  )
}

