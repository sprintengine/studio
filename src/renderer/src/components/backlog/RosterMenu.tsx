// The roster picker (MC-1880 / MC-1882): the New sprint dialog's choice of
// which saved roster staffs the run. It PURELY picks: "Manage rosters…" is the
// only action row (owner ruling 2026-07-26 — one door, no per-roster edit rows
// and no separate create row).
//
// One trigger: a bordered policy field. The compact chip variant, and its
// "use the inherited roster" option, went with the plan door that mounted them
// on step rows (2026-09-05).

import { useCallback, useState } from 'react'

import { CheckIcon, ChevronDownIcon } from '../AppIcons'
import { MenuItem, Popover, StatusDot, roveMenuFocus } from '../ui'
import { MENU_LIST_CLASS } from '../ui/menuClasses'
import type { SprintEngineRoster } from '../../types/workspace'
import { isNoRolesRosterRef } from '../workspace/newWorkspace/savedRosters'

// How the built-in no-roster choice READS (MC-2145 UX pass). The stored name
// stays `No roles` (`NO_ROLES_ROSTER_NAME` — frontmatter back-compat), but a
// dropdown whose resting label described what it ISN'T was the owner's exact
// complaint (2026-08-06: "it's a bit unintuitive to have a drop down that says
// no roles in it"). Picking just an agent IS what no-roster means — the agent
// picker beside this control is where WHICH agent gets chosen.
const JUST_AN_AGENT_LABEL = 'Just an agent'

const POLICY_ROSTER_TRIGGER_CLASS =
  'interactive inline-flex h-control-sm items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 text-meta text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring'

export function RosterMenu({
  rosters,
  selectedName,
  onSelect,
  onManageRosters,
  ariaLabel = 'Roster for this sprint',
}: {
  /** The user's saved rosters, as records — the menu shows what each staffs. */
  rosters: ReadonlyArray<SprintEngineRoster>
  selectedName: string | null
  onSelect: (name: string | undefined) => void
  onManageRosters: () => void
  ariaLabel?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const noRolesSelected = !selectedName || isNoRolesRosterRef(selectedName)
  // A roster named by a caller that no longer exists keeps its name and is
  // marked "(not found)". It must never silently read as the default — the run
  // start fails loudly instead (the epic's standing decision).
  const missing = Boolean(
    selectedName
    && !isNoRolesRosterRef(selectedName)
    && !rosters.some((roster) => roster.name.trim().toLowerCase() === selectedName.trim().toLowerCase()),
  )
  const triggerLabel = noRolesSelected ? JUST_AN_AGENT_LABEL : selectedName ?? JUST_AN_AGENT_LABEL
  // The tier reaches a screen reader too, which cannot see the border.
  const triggerTier = missing ? ' (not found)' : ''
  const pick = (name: string | undefined): void => {
    onSelect(name)
    setOpen(false)
  }

  // The kit's menu keyboard model (design-system/components/menu): focus lands on
  // the first row when the menu opens, and ArrowUp/Down (wrapping), Home and End
  // rove through the `MenuItem`s. The surface `Popover` draws carries
  // `role="menu"`, which is what `roveMenuFocus` walks — the rows inside it are
  // the kit's own, so every menu opened from this control has the same keys.
  const focusFirstRow = useCallback((surface: HTMLElement) => {
    surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')?.focus()
  }, [])

  // The trailing cell every roster row carries: the silent check (aria-checked
  // already announces it) and the supporting text. Outside the truncating label
  // so a long roster name cannot clip either.
  const trailing = (checked: boolean, note: string, noteClassName = ''): JSX.Element => (
    <>
      {checked ? <CheckIcon className="icon-xs shrink-0" /> : null}
      <span className={`shrink-0 text-micro text-[color:var(--text-subtle)] ${noteClassName}`}>{note}</span>
    </>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[260px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstRow}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          {...triggerProps}
          onClick={(event) => {
            // A host may make the surrounding row a click target of its own;
            // opening the menu must not also re-select what sits underneath.
            event.stopPropagation()
            togglePopover()
          }}
          // The trigger's own text is only a roster NAME, which does not say what
          // the control does. `ariaLabel` names the popup; the button needs its
          // own accessible name or a screen-reader user hears just "Mobile UI".
          aria-label={`${ariaLabel}: ${triggerLabel}${triggerTier}`}
          className={POLICY_ROSTER_TRIGGER_CLASS}
        >
          {/* The missing tier is a status, so it is carried by the app's status
              glyph beside the word — never by tone ink or a tinted edge alone. */}
          {missing ? <StatusDot tone="warn" /> : null}
          <span>
            {triggerLabel}
            {missing ? ' (not found)' : ''}
          </span>
          <ChevronDownIcon className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
        </button>
      )}
    >
      <div onKeyDown={(event) => roveMenuFocus(event, event.currentTarget.closest<HTMLElement>('[role="menu"]'))}>
        {/* A missing roster leads, so the problem is the first thing read. It is
            the current choice, so it is checked — and it cannot be re-chosen, so
            the row is disabled rather than a control that does nothing. The
            reason is its supporting line; the warn glyph, not red ink, says why. */}
        {missing && selectedName ? (
          <>
            <MenuItem
              checked
              selection="one-of"
              disabled
              onClick={() => {}}
              icon={<StatusDot tone="warn" label="Not found" />}
              trailing={trailing(false, 'not found')}
            >
              {selectedName}
            </MenuItem>
            <div aria-hidden="true" className="h-1.5" />
          </>
        ) : null}
        {/* Just an agent — the absence of a roster. Pinned first, no staffing
            summary: which agent is the picker's job, not this menu's. */}
        <MenuItem
          checked={noRolesSelected}
          selection="one-of"
          onClick={() => pick(undefined)}
          trailing={trailing(noRolesSelected, 'no roles')}
        >
          {JUST_AN_AGENT_LABEL}
        </MenuItem>
        <div aria-hidden="true" className="h-1.5" />
        {rosters.map((roster) => {
          const staffed = Object.values(roster.roleCounts).filter((count) => (count ?? 0) > 0).length
          const checked = !noRolesSelected
            && roster.name.trim().toLowerCase() === (selectedName ?? '').trim().toLowerCase()
          return (
            <MenuItem
              key={roster.id}
              checked={checked}
              selection="one-of"
              onClick={() => pick(roster.name)}
              // A name alone is not enough to choose between rosters.
              trailing={trailing(checked, `${staffed} role${staffed === 1 ? '' : 's'}`, 'tabular-nums')}
            >
              {roster.name}
            </MenuItem>
          )
        })}
        <div aria-hidden="true" className="h-1.5" />
        <MenuItem
          onClick={() => {
            setOpen(false)
            onManageRosters()
          }}
        >
          Manage rosters…
        </MenuItem>
      </div>
    </Popover>
  )
}
