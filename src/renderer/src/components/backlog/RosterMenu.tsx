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

import { useState } from 'react'

import { CheckIcon } from '../AppIcons'
import { Popover } from '../ui'
import { MENU_ITEM_CLASS, MENU_LIST_CLASS } from '../ui/menuClasses'
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
// interesting state. A MISSING roster is loud, because that step cannot start.
export const ROW_ROSTER_TRIGGER_CLASS: Record<'inherited' | 'override' | 'missing', string> = {
  inherited: `${ROW_ROSTER_TRIGGER_BASE} text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-default)]`,
  override: `${ROW_ROSTER_TRIGGER_BASE} border border-[color:var(--border-subtle)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-active)]`,
  missing: `${ROW_ROSTER_TRIGGER_BASE} border border-[color:var(--tone-warn)] text-[color:var(--tone-warn)] hover:bg-[color:var(--bg-active)]`,
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
  // The shared menu row (MC-2103). It used to be a local re-type at `rounded
  // px-2` with no disabled state and an inset fill — the shape the menu spec
  // rules out, and a copy that could not follow the canon when it moved.
  const itemClass = `${MENU_ITEM_CLASS} text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]`

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
      surfaceClassName={`w-[260px] ${MENU_LIST_CLASS}`}
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
          aria-label={`${ariaLabel}: ${triggerLabel}${triggerTier}`}
          className={variant === 'row' ? ROW_ROSTER_TRIGGER_CLASS[triggerTone] : POLICY_ROSTER_TRIGGER_CLASS}
        >
          <span
            // A row chip truncates to keep the step's title readable, so the
            // full team name stays reachable on hover rather than lost.
            {...(variant === 'row' ? { title: `${triggerLabel}${triggerTier}` } : {})}
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
            <span className="shrink-0 max-w-[7.5rem] truncate text-micro text-[color:var(--text-subtle)]">
              {isNoRolesRosterRef(inherit.resolvedLabel) ? JUST_AN_AGENT_LABEL : inherit.resolvedLabel}
            </span>
          </button>
          {/* Spacing separates the groups — never hairlines (owner, 2026-08-06:
              "we don't need these, we can just use spacing instead"). */}
          <div aria-hidden="true" className="h-1.5" />
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
          <div aria-hidden="true" className="h-1.5" />
        </>
      ) : null}
      {/* Just an agent — the absence of a roster. Pinned first, no staffing
          summary: which agent is the picker's job, not this menu's. */}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={noRolesSelected}
        className={itemClass}
        onClick={() => pick(undefined)}
      >
        <span className="min-w-0 flex-1 truncate">{JUST_AN_AGENT_LABEL}</span>
        {noRolesSelected ? <CheckIcon className="icon-xs shrink-0" /> : null}
        <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">no roles</span>
      </button>
      <div aria-hidden="true" className="h-1.5" />
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
            <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
              {staffed} role{staffed === 1 ? '' : 's'}
            </span>
          </button>
        )
      })}
      <div aria-hidden="true" className="h-1.5" />
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
