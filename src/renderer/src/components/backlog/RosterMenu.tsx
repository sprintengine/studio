// The horizon's roster picker (MC-1880 / MC-1882), lifted out of
// RoadmapEditorPanel so the plan column keeps using the SAME menu the policy bar
// does rather than growing a lookalike. It PURELY picks: "Manage rosters…" is
// the only action row (owner ruling 2026-07-26 — one door, no per-roster edit
// rows and no separate create row).
//
// Two triggers, one menu body. The policy control is a bordered field; a step
// row is a compact chip — resting, never hover-only (MC-2066) — that gains one
// extra leading option: "Use the horizon's roster", which clears the override
// and names what the step falls back to, so the choice is never made blind.

import { useCallback, useState } from 'react'

import { CheckIcon, ChevronDownIcon } from '../AppIcons'
import { MenuItem, Popover, StatusDot, Tooltip, roveMenuFocus } from '../ui'
import { MENU_LIST_CLASS } from '../ui/menuClasses'
import type { SprintEngineRoster } from '../../types/workspace'
import { isNoRolesRosterRef } from '../workspace/newWorkspace/savedRosters'

// How the built-in no-roster choice READS (MC-2145 UX pass). The stored name
// stays `No roles` (`NO_ROLES_ROSTER_NAME` — frontmatter back-compat), but a
// dropdown whose resting label described what it ISN'T was the owner's exact
// complaint (2026-08-06: "it's a bit unintuitive to have a drop down that says
// no roles in it"). Picking just an agent IS what no-roster means — the agent
// picker beside this control is where WHICH agent gets chosen.
export const JUST_AN_AGENT_LABEL = 'Just an agent'

export const POLICY_ROSTER_TRIGGER_CLASS =
  'interactive inline-flex h-control-sm items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 text-meta text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring'

const ROW_ROSTER_TRIGGER_BASE =
  'interactive inline-flex max-w-[5.25rem] shrink-0 items-center gap-1 rounded-sm px-1.5 text-micro leading-[17px] focus-visible:focus-ring'

// How a step row's team reads at a glance. It RESTS visible on every row
// (MC-2066), deliberately reversing MC-1924's density call for this one control:
// the thing that decides who does the work was the least visible thing on the
// surface, reachable only by hovering the row it belongs to.
//
// The three tiers stay distinguishable without hover. INHERITED is quiet — it is
// the common case and says the horizon decides — but it is legible at rest. An
// OVERRIDE is a bordered chip, because a step deciding for itself is the
// interesting state. A MISSING roster is loud, because that step cannot start —
// but loud is a warn `StatusDot` leading the label, never a tone-tinted border
// or tone ink (status is a glyph, chrome stays neutral; design-system audit
// 2026-09-02). The chip keeps the override's bordered shape so a missing
// roster still reads as "this step decided for itself".
export const ROW_ROSTER_TRIGGER_CLASS: Record<'inherited' | 'override' | 'missing', string> = {
  inherited: `${ROW_ROSTER_TRIGGER_BASE} text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-default)]`,
  override: `${ROW_ROSTER_TRIGGER_BASE} border border-[color:var(--border-subtle)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-active)]`,
  missing: `${ROW_ROSTER_TRIGGER_BASE} border border-[color:var(--border-subtle)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-active)]`,
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
  const triggerLabel = noRolesSelected ? JUST_AN_AGENT_LABEL : selectedName ?? JUST_AN_AGENT_LABEL
  // On a step row, "inherited" is the ABSENCE of an override — exactly
  // `inherit.selected`. The tone must never be derived from the label, or a step
  // that deliberately picks the same roster the horizon uses would read as
  // inherited and become invisible as an override.
  const triggerTone: 'inherited' | 'override' | 'missing' = missing
    ? 'missing'
    : inherit?.selected
      ? 'inherited'
      : 'override'
  // …and the same source of truth carries the tier to a screen reader, which
  // cannot see the border that distinguishes the two. Without it "Mobile UI"
  // reads identically whether the step chose it or the horizon did.
  const triggerTier = missing
    ? ' (not found)'
    : inherit
      ? inherit.selected
        ? ' (inherited from this horizon)'
        : ' (set for this step)'
      : ''
  const pick = (name: string | undefined): void => {
    onSelect(name)
    setOpen(false)
  }

  // The kit's menu keyboard model (design-system/components/menu): focus lands on
  // the first row when the menu opens, and ArrowUp/Down (wrapping), Home and End
  // rove through the `MenuItem`s. The surface `Popover` draws carries
  // `role="menu"`, which is what `roveMenuFocus` walks — the rows inside it are
  // the kit's own, so a menu opened from a step row and one opened from the
  // policy bar are the same menu with the same keys.
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
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        const trigger = (
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
            aria-label={`${ariaLabel}: ${triggerLabel}${triggerTier}`}
            className={variant === 'row' ? ROW_ROSTER_TRIGGER_CLASS[triggerTone] : POLICY_ROSTER_TRIGGER_CLASS}
          >
            {/* The missing tier is a status, so it is carried by the app's status
                glyph beside the word — never by tone ink or a tinted edge alone. */}
            {missing ? <StatusDot tone="warn" /> : null}
            <span className={variant === 'row' ? 'min-w-0 truncate' : undefined}>
              {triggerLabel}
              {missing ? ' (not found)' : ''}
            </span>
            {variant === 'row' ? null : (
              <ChevronDownIcon className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            )}
          </button>
        )
        // A row chip truncates to keep the step's title readable, so the full
        // team name and its tier stay reachable — through the product tooltip on
        // the focusable trigger, so the keyboard reaches it too, never a native
        // `title=`.
        return variant === 'row' ? (
          <Tooltip content={`${triggerLabel}${triggerTier}`} wrapperClassName="inline-flex min-w-0">
            {trigger}
          </Tooltip>
        ) : (
          trigger
        )
      }}
    >
      <div onKeyDown={(event) => roveMenuFocus(event, event.currentTarget.closest<HTMLElement>('[role="menu"]'))}>
        {inherit ? (
          <>
            <MenuItem
              checked={inherit.selected}
              selection="one-of"
              onClick={() => {
                inherit.onChoose()
                setOpen(false)
              }}
              trailing={trailing(
                inherit.selected,
                isNoRolesRosterRef(inherit.resolvedLabel) ? JUST_AN_AGENT_LABEL : inherit.resolvedLabel,
                'max-w-[7.5rem] truncate',
              )}
            >
              Use the horizon&apos;s roster
            </MenuItem>
            {/* Spacing separates the groups — never hairlines (owner, 2026-08-06:
                "we don't need these, we can just use spacing instead"). */}
            <div aria-hidden="true" className="h-1.5" />
          </>
        ) : null}
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
