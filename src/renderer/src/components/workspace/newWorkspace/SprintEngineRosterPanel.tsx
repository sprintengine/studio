// The sprint wizard's Roster step (MC-1646, mockup §1). One reading column:
// the roster is a single dense hairline list summarized by an overlapping glyph
// stack, and saved rosters collapse into a quiet
// "Roster: <name>" menu instead of a permanent rail. A roster is a set of roles
// and nothing else (MC-2064): "No roles" is not a formation of this panel but
// the level above it, so the panel renders role rows unconditionally and the
// create surface decides whether to show it at all.

import React from 'react'

import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoleRegistry,
  SprintEngineRoster,
} from '../../../types/workspace'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  getSprintEngineWizardRoleSummary,
  listSprintEngineWizardRoles,
} from '../../../utils/sprintengineRoleOptions'
import { CheckIcon, ChevronDownIcon } from '../../AppIcons'
import {
  CliModelPickerButton,
  GhostButton,
  Input,
  MENU_GROUP_LABEL_CLASS,
  MENU_LIST_CLASS,
  MenuDivider,
  MenuItem,
  Popover,
  PrimaryButton,
  RoleAvatar,
  roveMenuFocus,
  Switch,
} from '../../ui'
import { type SprintEngineCliOption } from './SprintEngineRosterTable'
import {
  NO_ROLES_ROSTER_ID,
  NO_ROLES_ROSTER_NAME,
  isNoRolesRosterRef,
  sprintEngineRosterNameTaken,
} from './savedRosters'

// Effective launch model for a role: explicit override (string), otherwise the
// CLI default (undefined -> no model flag). Mirrors the roster table.
function effectiveRoleModel(
  role: SprintEngineRoleId,
  roleModelOverrides: SprintEngineRoleModelOverrides | undefined,
): string | undefined {
  const override = roleModelOverrides?.[role]
  if (override === null) return undefined
  return override || undefined
}

// Effective effort level for a role: an explicit level, otherwise undefined —
// the CLI's own default effort, which passes no flag. Same shape as the model.
function effectiveRoleReasoning(
  role: SprintEngineRoleId,
  roleReasoningOverrides: SprintEngineRoleReasoningOverrides | undefined,
): string | undefined {
  const override = roleReasoningOverrides?.[role]
  if (override === null) return undefined
  return override || undefined
}

export function SprintEngineRosterPanel({
  roleCounts,
  roleCliDefaults,
  roleModelOverrides,
  roleReasoningOverrides,
  onSetRoleCount,
  onSetRoleCli,
  onSetRoleModel,
  onSetRoleReasoning,
  cliOptions,
  registry,
  registryStatus,
  disabledRoleIds,
  rosterDisabled,
  hasExistingTeam,
  rosters,
  selectedRosterId,
  selectedRosterDirty,
  onSelectRoster,
  onSaveRoster,
  onUpdateRoster,
  onRenameRoster,
  onDeleteRoster,
}: {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
  /**
   * Per-role reasoning-effort level (MC-1885). OPT-IN, and only as a pair with
   * `onSetRoleReasoning`: a host with nowhere to persist a level — the saved-
   * roster manager, or an existing run whose seats already carry their level in
   * run.yaml — passes neither and the rows render no effort control at all,
   * rather than one that silently forgets.
   */
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides
  onSetRoleCount: (role: SprintEngineRoleId, count: number) => void
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetRoleModel: (role: SprintEngineRoleId, model: string | null) => void
  onSetRoleReasoning?: (role: SprintEngineRoleId, reasoning: string | null) => void
  cliOptions: SprintEngineCliOption[]
  registry: SprintEngineRoleRegistry | null
  registryStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  disabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
  /** Existing run: role membership is read-only (runtimes stay editable). */
  rosterDisabled: boolean
  hasExistingTeam: boolean
  rosters: SprintEngineRoster[]
  selectedRosterId: string | null
  selectedRosterDirty: boolean
  onSelectRoster: (id: string | null) => void
  onSaveRoster: (name: string) => void
  onUpdateRoster: (id: string, name: string) => void
  onRenameRoster: (id: string, name: string) => void
  onDeleteRoster: (id: string) => void
}) {
  // One roster list for every staffable role, reviewers included (MC-1886):
  // staffing a role makes it available to the architect, which is the same
  // meaning for a reviewer as for a builder.
  const roles = listSprintEngineWizardRoles(registry, disabledRoleIds)
  const onRoles = roles.filter((role) => (roleCounts[role] ?? 0) > 0)

  return (
    <div className="flex flex-col gap-1">
      <div className="mt-4 flex items-center gap-2.5">
        <RoleGlyphStack roles={onRoles} registry={registry} />
        <span className="text-meta tabular-nums text-[color:var(--text-muted)]">
          {registryStatus === 'loading'
            ? 'Loading roles'
            : `${onRoles.length} role${onRoles.length === 1 ? '' : 's'}`}
        </span>
        <span className="flex-1" />
        {!hasExistingTeam ? (
          <SavedRostersMenu
            rosters={rosters}
            selectedRosterId={selectedRosterId}
            selectedRosterDirty={selectedRosterDirty}
            onSelectRoster={onSelectRoster}
            onSaveRoster={onSaveRoster}
            onUpdateRoster={onUpdateRoster}
            onRenameRoster={onRenameRoster}
            onDeleteRoster={onDeleteRoster}
          />
        ) : null}
      </div>

      <div className="mt-2 border-t border-[color:var(--border-subtle)]">
        {roles.map((role) => (
          <RosterRoleRow
            key={role}
            role={role}
            isOn={(roleCounts[role] ?? 0) > 0}
            registry={registry}
            cliOptions={cliOptions}
            roleCliDefaults={roleCliDefaults}
            roleModelOverrides={roleModelOverrides}
            roleReasoningOverrides={roleReasoningOverrides}
            rosterDisabled={rosterDisabled}
            onSetRoleCount={onSetRoleCount}
            onSetRoleCli={onSetRoleCli}
            onSetRoleModel={onSetRoleModel}
            onSetRoleReasoning={onSetRoleReasoning}
          />
        ))}
      </div>
    </div>
  )
}

// Overlapping avatar stack summarizing the staffed roles.
function RoleGlyphStack({
  roles,
  registry,
}: {
  roles: SprintEngineRoleId[]
  registry: SprintEngineRoleRegistry | null
}) {
  if (roles.length === 0) {
    return <span className="text-meta text-[color:var(--text-muted)]">No roles on</span>
  }
  return (
    <span className="flex pl-1.5" aria-hidden="true">
      {roles.map((role) => (
        <span
          key={role}
          className="-ml-1.5 inline-flex rounded-full ring-2 ring-[color:var(--bg-app)]"
        >
          <RoleAvatar role={role} registry={registry} size="sm" ariaLabel="" />
        </span>
      ))}
    </span>
  )
}

// One dense roster row: glyph · name over a full, untruncated description ·
// full-width model chip · switch. Off roles stay visible but muted, with the
// runtime chip withheld (invisible keeps the columns aligned). Every role
// switches off freely — no role is floored on, and none is badged as the one
// that plans (MC-2055).
function RosterRoleRow({
  role,
  isOn,
  registry,
  cliOptions,
  roleCliDefaults,
  roleModelOverrides,
  roleReasoningOverrides,
  rosterDisabled,
  onSetRoleCount,
  onSetRoleCli,
  onSetRoleModel,
  onSetRoleReasoning,
}: {
  role: SprintEngineRoleId
  isOn: boolean
  registry: SprintEngineRoleRegistry | null
  cliOptions: SprintEngineCliOption[]
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides
  rosterDisabled: boolean
  onSetRoleCount: (role: SprintEngineRoleId, count: number) => void
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetRoleModel: (role: SprintEngineRoleId, model: string | null) => void
  onSetRoleReasoning?: (role: SprintEngineRoleId, reasoning: string | null) => void
}) {
  const label = getSprintEngineRoleLabel(role, registry)
  const summary = getSprintEngineWizardRoleSummary(role, registry)
  const roleCli = roleCliDefaults[role] ?? cliOptions[0]?.value ?? 'claude-code'
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--border-subtle)] py-2">
      <RoleAvatar role={role} registry={registry} size="md" ariaLabel="" className={isOn ? undefined : 'opacity-55'} />
      <span className="min-w-0 flex-1">
        <span
          className={`block text-body ${
            isOn ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
          }`}
        >
          {label}
        </span>
        <span
          className={`mt-0.5 block text-micro leading-4 ${
            isOn ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-disabled)]'
          }`}
        >
          {summary}
        </span>
      </span>
      <span className={isOn ? undefined : 'invisible'}>
        <CliModelPickerButton
          ariaLabel={`${label} agent runtime`}
          options={cliOptions}
          cli={roleCli}
          maxWidthClassName="max-w-none"
          effectiveModelFor={(candidateCli) =>
            candidateCli === roleCli ? effectiveRoleModel(role, roleModelOverrides) : undefined
          }
          {...(onSetRoleReasoning
            ? {
                effectiveReasoningFor: (candidateCli: AgentCli) =>
                  candidateCli === roleCli ? effectiveRoleReasoning(role, roleReasoningOverrides) : undefined,
                onSelectReasoning: (_cli: AgentCli, reasoning: string | null) =>
                  onSetRoleReasoning(role, reasoning),
              }
            : {})}
          onSelectCli={(nextCli) => onSetRoleCli(role, nextCli)}
          onSelectModel={(nextCli, nextModel) => {
            if (nextCli !== roleCli) onSetRoleCli(role, nextCli)
            onSetRoleModel(role, nextModel)
          }}
        />
      </span>
      <Switch
        ariaLabel={label}
        checked={isOn}
        disabled={rosterDisabled}
        onChange={(next) => onSetRoleCount(role, next ? 1 : 0)}
      />
    </div>
  )
}

// Quiet saved-rosters menu: load / save as new / update / rename / delete, all in
// one popover so the roster header stays a single line. "Custom" is the current
// unsaved config. Exported (MC-2064) because the create surface renders it on
// its own when "No roles" is selected — the roster panel is not mounted then,
// and this menu is the way back to a roster.
function SavedRostersMenu({
  rosters,
  selectedRosterId,
  selectedRosterDirty,
  onSelectRoster,
  onSaveRoster,
  onUpdateRoster,
  onRenameRoster,
  onDeleteRoster,
}: {
  rosters: SprintEngineRoster[]
  selectedRosterId: string | null
  selectedRosterDirty: boolean
  onSelectRoster: (id: string | null) => void
  onSaveRoster: (name: string) => void
  onUpdateRoster: (id: string, name: string) => void
  onRenameRoster: (id: string, name: string) => void
  onDeleteRoster: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  // 'idle' | 'adding' (save as new) | 'renaming' (selected roster).
  const [editing, setEditing] = React.useState<'idle' | 'adding' | 'renaming'>('idle')
  const [name, setName] = React.useState('')
  // The built-in "No roles" is synthetic and never in `rosters` (MC-1876), so
  // it is tracked by id rather than resolved to a record. That is also why it
  // has no Update / Rename / Delete: there is no record to act on.
  const noRolesSelected = isNoRolesRosterRef(selectedRosterId)
  const selectedRoster = selectedRosterId && !noRolesSelected
    ? rosters.find((roster) => roster.id === selectedRosterId) ?? null
    : null
  const triggerLabel = noRolesSelected
    ? `Roster: ${NO_ROLES_ROSTER_NAME}`
    : selectedRoster
      ? `Roster: ${selectedRoster.name}${selectedRosterDirty ? ' · edited' : ''}`
      : 'Roster: Custom'

  const close = () => {
    setEditing('idle')
    setName('')
  }
  // The menu surface, so the rows rove with the arrow keys like every other
  // menu (menu/component.md → Accessibility); focus lands on the first row on
  // open, as ContextMenu does, so the keys work immediately. The rows are the
  // kit's `MenuItem` — the local `itemClass` they used to share was a third
  // spelling of the menu row with no ring and an inset fill.
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  // Stable identity: `Popover` keys its auto-focus effect on this callback, so an
  // inline arrow function would re-run it on every render and pull the keyboard
  // cursor back to the first row while the menu is open.
  const focusFirstMenuItem = React.useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')?.focus()
  }, [])

  const trimmed = name.trim()
  const collides = sprintEngineRosterNameTaken(
    rosters,
    trimmed,
    editing === 'renaming' ? selectedRoster?.id ?? null : null,
  )
  const canSubmit = trimmed.length > 0 && !collides
  const submitName = () => {
    if (!canSubmit) return
    if (editing === 'renaming' && selectedRoster) onRenameRoster(selectedRoster.id, trimmed)
    else onSaveRoster(trimmed)
    close()
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) close()
      }}
      ariaLabel="Saved rosters"
      popupRole="menu"
      placement="bottom-end"
      className="shrink-0"
      surfaceClassName={`w-[248px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusFirstMenuItem}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="
            inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-meta font-medium text-[color:var(--text-muted)]
            transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
            focus-visible:focus-ring
          "
          {...triggerProps}
        >
          {triggerLabel}
          <ChevronDownIcon className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
        </button>
      )}
    >
      {editing !== 'idle' ? (
        <div className="flex flex-col gap-1 p-1">
          <Input
            autoFocus
            value={name}
            placeholder="Roster name"
            aria-label={editing === 'renaming' ? 'Rename roster' : 'New roster name'}
            aria-invalid={collides}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitName()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
            // The error edge is the kit's own `aria-invalid` state (already
            // set above): drawn by an attribute variant that deterministically
            // beats the chrome's resting border and hover lift — a bare
            // className tied with them and lost the edge on hover (MC-2114).
          />
          {collides ? (
            <span className="px-0.5 text-micro text-[color:var(--tone-error)]">
              A roster named “{trimmed}” already exists.
            </span>
          ) : null}
          <div className="flex items-center justify-end gap-1">
            <GhostButton onClick={close}>Cancel</GhostButton>
            <PrimaryButton disabled={!canSubmit} onClick={submitName}>
              {editing === 'renaming' ? 'Rename' : 'Save'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}>
          {/* MC-1876: the built-in is pinned first and separated from saved
              rosters, because choosing it means "no roster" — not "a roster
              named No roles". It carries no staffing summary for the same
              reason, and offers no rename/delete. */}
          <MenuItem
            checked={noRolesSelected}
            selection="one-of"
            onClick={() => { onSelectRoster(NO_ROLES_ROSTER_ID); setOpen(false) }}
            trailing={
              <>
                {/* aria-checked on the radio already announces the choice. */}
                {noRolesSelected ? <CheckIcon className="icon-xs shrink-0" /> : null}
                <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">default</span>
              </>
            }
          >
            {NO_ROLES_ROSTER_NAME}
          </MenuItem>
          <MenuDivider />
          {/* The way to a hand-tuned role set whenever something else is
              selected — including the built-in: with "No roles" a level above
              rosters (MC-2064) this row is how a fresh install, whose only
              other entry is the pinned default, reaches the role rows at all. */}
          {selectedRosterId != null ? (
            <MenuItem onClick={() => { onSelectRoster(null); setOpen(false) }}>Custom roster</MenuItem>
          ) : null}
          {rosters.length > 0 ? (
            <>
              <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>Saved rosters</div>
              {rosters.map((roster) => {
                const total = Object.values(roster.roleCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0)
                return (
                  <MenuItem
                    key={roster.id}
                    onClick={() => {
                      onSelectRoster(roster.id)
                      setOpen(false)
                    }}
                    trailing={
                      <>
                        {/* Unlike the pinned "No roles" radio above, these rows
                            are plain menuitems: nothing else announces which
                            one is in use, so the mark carries its own name. */}
                        {roster.id === selectedRosterId ? (
                          <>
                            <CheckIcon className="icon-xs shrink-0" />
                            <span className="sr-only">Selected</span>
                          </>
                        ) : null}
                        <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
                          {total} role{total === 1 ? '' : 's'}
                        </span>
                      </>
                    }
                  >
                    {roster.name}
                  </MenuItem>
                )
              })}
              <MenuDivider />
            </>
          ) : null}
          <MenuItem onClick={() => setEditing('adding')}>Save as new roster…</MenuItem>
          {selectedRoster && selectedRosterDirty ? (
            <MenuItem
              onClick={() => {
                onUpdateRoster(selectedRoster.id, selectedRoster.name)
                setOpen(false)
              }}
            >
              Update “{selectedRoster.name}”
            </MenuItem>
          ) : null}
          {selectedRoster ? (
            <>
              <MenuItem
                onClick={() => {
                  setName(selectedRoster.name)
                  setEditing('renaming')
                }}
              >
                Rename…
              </MenuItem>
              <MenuItem
                variant="danger"
                onClick={() => {
                  onDeleteRoster(selectedRoster.id)
                  setOpen(false)
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : null}
        </div>
      )}
    </Popover>
  )
}
