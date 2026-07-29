// The horizon's roster picker (MC-1880 / MC-1882), lifted out of
// RoadmapEditorPanel so the plan column keeps using the SAME menu the policy bar
// does rather than growing a lookalike. It PURELY picks: "Manage rosters…" is
// the only action row (owner ruling 2026-07-26 — one door, no per-roster edit
// rows and no separate create row).
//
// Two triggers, one menu body. The policy control is a bordered field; a step
// row is a quiet chip that gains one extra leading option — "Use the horizon's
// roster", which clears the override and names what the step falls back to, so
// the choice is never made blind.

import { useState } from 'react'

import { CheckIcon } from '../AppIcons'
import { Popover } from '../ui'
import type { SprintEngineRoster } from '../../types/workspace'
import { NO_ROLES_ROSTER_NAME, isNoRolesRosterRef } from '../workspace/newWorkspace/savedRosters'

export const POLICY_ROSTER_TRIGGER_CLASS =
  'interactive inline-flex h-[30px] items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 text-[12px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]'

const ROW_ROSTER_TRIGGER_BASE =
  'interactive inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] leading-[17px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-focus)]'

// How a step row's roster reads at a glance. The common case is every step
// inheriting, so INHERITED is quiet — it only appears on hover or focus (the
// density pass, MC-1924). An OVERRIDE and a MISSING roster are always visible,
// because both are things you would want to see without hovering every row.
export const ROW_ROSTER_TRIGGER_CLASS: Record<'inherited' | 'override' | 'missing', string> = {
  inherited: `${ROW_ROSTER_TRIGGER_BASE} text-[color:var(--text-subtle)] opacity-0 hover:bg-[color:var(--bg-active)] group-hover/step:opacity-100 group-focus-within/step:opacity-100 focus-visible:opacity-100`,
  override: `${ROW_ROSTER_TRIGGER_BASE} text-[color:var(--text-muted)] hover:bg-[color:var(--bg-active)]`,
  missing: `${ROW_ROSTER_TRIGGER_BASE} text-[color:var(--tone-warn)] hover:bg-[color:var(--bg-active)]`,
}

export function RosterMenu({
  rosters,
  selectedName,
  onSelect,
  onManageRosters,
  inherit,
  variant = 'control',
  ariaLabel = 'Roster for every sprint this horizon starts',
}: {
  /** The user's saved rosters, as records — the menu shows what each staffs. */
  rosters: ReadonlyArray<SprintEngineRoster>
  selectedName: string | null
  onSelect: (name: string | undefined) => void
  onManageRosters: () => void
  /** Step rows only: clearing the override, and the name it falls back to. */
  inherit?: { selected: boolean; resolvedLabel: string; onChoose: () => void }
  variant?: 'control' | 'row'
  ariaLabel?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const noRolesSelected = !selectedName || isNoRolesRosterRef(selectedName)
  // A roster named in frontmatter that no longer exists keeps its name and is
  // marked "(not found)". It must never silently read as the default — the step
  // start fails loudly instead (the epic's standing decision).
  const missing = Boolean(
    selectedName
    && !isNoRolesRosterRef(selectedName)
    && !rosters.some((roster) => roster.name.trim().toLowerCase() === selectedName.trim().toLowerCase()),
  )
  const triggerLabel = noRolesSelected ? NO_ROLES_ROSTER_NAME : selectedName ?? NO_ROLES_ROSTER_NAME
  // On a step row, "inherited" is the ABSENCE of an override — exactly
  // `inherit.selected`. The tone must never be derived from the label, or a step
  // that deliberately picks the same roster the horizon uses would read as
  // inherited and become invisible as an override.
  const triggerTone: 'inherited' | 'override' | 'missing' = missing
    ? 'missing'
    : inherit?.selected
      ? 'inherited'
      : 'override'
  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'

  const pick = (name: string | undefined): void => {
    onSelect(name)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName="w-[260px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          {...triggerProps}
          onClick={(event) => {
            // The plan column's row is a sibling click target; opening the menu
            // must not also re-select the row underneath.
            event.stopPropagation()
            togglePopover()
          }}
          // The trigger's own text is only a roster NAME, which does not say what
          // the control does. `ariaLabel` names the popup; the button needs its
          // own accessible name or a screen-reader user hears just "Mobile UI".
          aria-label={`${ariaLabel}: ${triggerLabel}${missing ? ' (not found)' : ''}`}
          className={variant === 'row' ? ROW_ROSTER_TRIGGER_CLASS[triggerTone] : POLICY_ROSTER_TRIGGER_CLASS}
        >
          <span
            className={
              variant === 'row'
                ? 'min-w-0 truncate'
                : missing
                  ? 'text-[color:var(--tone-error)]'
                  : undefined
            }
          >
            {triggerLabel}
            {missing ? ' (not found)' : ''}
          </span>
          {variant === 'row' ? null : (
            <span aria-hidden="true" className="shrink-0 text-[color:var(--text-subtle)]">▾</span>
          )}
        </button>
      )}
    >
      {inherit ? (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={inherit.selected}
            className={itemClass}
            onClick={() => {
              inherit.onChoose()
              setOpen(false)
            }}
          >
            <span className="min-w-0 flex-1 truncate">Use the horizon&apos;s roster</span>
            {inherit.selected ? <CheckIcon className="icon-xs shrink-0" /> : null}
            <span className="shrink-0 max-w-[7.5rem] truncate text-[11px] text-[color:var(--text-subtle)]">
              {inherit.resolvedLabel}
            </span>
          </button>
          <div className="my-1 border-t border-[color:var(--border-subtle)]" />
        </>
      ) : null}
      {/* A missing roster leads, so the problem is the first thing read. */}
      {missing && selectedName ? (
        <>
          <button type="button" role="menuitemradio" aria-checked className={itemClass}>
            <span className="min-w-0 flex-1 truncate text-[color:var(--tone-error)]">
              {selectedName} (not found)
            </span>
          </button>
          <div className="my-1 border-t border-[color:var(--border-subtle)]" />
        </>
      ) : null}
      {/* "No roles" is the absence of a roster, so it is pinned first,
          separated, and shows no staffing summary. */}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={noRolesSelected}
        className={itemClass}
        onClick={() => pick(undefined)}
      >
        <span className="min-w-0 flex-1 truncate">{NO_ROLES_ROSTER_NAME}</span>
        {noRolesSelected ? <CheckIcon className="icon-xs shrink-0" /> : null}
        <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">default</span>
      </button>
      <div className="my-1 border-t border-[color:var(--border-subtle)]" />
      {rosters.map((roster) => {
        const staffed = Object.values(roster.roleCounts).filter((count) => (count ?? 0) > 0).length
        const checked = !noRolesSelected
          && roster.name.trim().toLowerCase() === (selectedName ?? '').trim().toLowerCase()
        return (
          <button
            key={roster.id}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            className={itemClass}
            onClick={() => pick(roster.name)}
          >
            <span className="min-w-0 flex-1 truncate">{roster.name}</span>
            {/* Every row here is a menuitemradio, so aria-checked already
                announces the choice and the mark stays silent. It sits outside
                the truncating label so a long roster name cannot clip it. */}
            {checked ? <CheckIcon className="icon-xs shrink-0" /> : null}
            {/* A name alone is not enough to choose between rosters. */}
            <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
              {staffed} role{staffed === 1 ? '' : 's'}
            </span>
          </button>
        )
      })}
      <div className="my-1 border-t border-[color:var(--border-subtle)]" />
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          setOpen(false)
          onManageRosters()
        }}
      >
        <span className="min-w-0 flex-1 truncate">Manage rosters…</span>
      </button>
    </Popover>
  )
}
