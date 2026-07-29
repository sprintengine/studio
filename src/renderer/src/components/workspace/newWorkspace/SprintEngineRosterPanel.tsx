// The sprint wizard's Roster step (MC-1646, mockup §1). One reading column:
// a segmented control chooses how the roster is formed (pick roles yourself /
// plain agent pool), the roster is a single dense hairline list summarized by
// an overlapping glyph stack, and saved rosters collapse into a quiet
// "Roster: <name>" menu instead of a permanent rail. Replaces the old
// "Your AI team" screen's banner, checkbox card, option cards, and boxed rail.

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
  SprintEngineRosterMode,
} from '../../../types/workspace'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  SPRINT_ENGINE_GENERAL_ROLE_ID,
  getSprintEngineWizardRoleSummary,
  isSprintEnginePlanningRole,
  listSprintEngineWizardRoles,
  sprintEngineRosterRoleFloor,
} from '../../../utils/sprintengineRoleOptions'
import { CheckIcon, ChevronDownIcon } from '../../AppIcons'
import { CliModelPickerButton, Field, Popover, PrimaryButton, RoleAvatar, SegmentedControl, Switch } from '../../ui'
import { AgentCliPicker, type SprintEngineCliOption } from './SprintEngineRosterTable'
import {
  NO_ROLES_ROSTER_ID,
  NO_ROLES_ROSTER_NAME,
  isNoRolesRosterRef,
  sprintEngineRosterNameTaken,
} from './savedRosters'

// How the roster is formed. Defined in shared (MC-1875) because a saved roster
// now persists it and `src/shared` cannot import renderer modules; re-exported
// here so every existing call site's import is unchanged.
export type { SprintEngineRosterMode }

const ROSTER_MODE_HELP: Record<SprintEngineRosterMode, string> = {
  roles: 'You choose the roles and models below. The architect plans within them.',
  pool: 'No specialist roles. A pool of plain agents shares one task graph.',
}

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
  rosterMode,
  onChangeRosterMode,
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
  poolAgentCount,
  onChangePoolAgentCount,
}: {
  rosterMode: SprintEngineRosterMode
  // Absent for an existing run: its formation is fixed, so no segmented control.
  onChangeRosterMode?: (mode: SprintEngineRosterMode) => void
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
  /** Pool mode: how many plain agents share the run (the concurrency cap). */
  poolAgentCount: number
  onChangePoolAgentCount: (value: number) => void
}) {
  // One roster list for every staffable role, reviewers included (MC-1886):
  // staffing a role makes it available to the architect, which is the same
  // meaning for a reviewer as for a builder.
  const roles = listSprintEngineWizardRoles(registry, disabledRoleIds)
  const onRoles = roles.filter((role) => (roleCounts[role] ?? 0) > 0)
  // The help line below the segments is the only place either formation is
  // explained, so it is the control's description, not loose copy near it.
  const formationHelpId = React.useId()

  return (
    <div className="flex flex-col gap-1">
      {onChangeRosterMode ? (
        <>
          <SegmentedControl<SprintEngineRosterMode>
            ariaLabel="How the roster is formed"
            ariaDescribedBy={formationHelpId}
            className="self-start"
            items={[
              { value: 'roles', label: 'Pick roles yourself' },
              { value: 'pool', label: 'Plain agent pool' },
            ]}
            value={rosterMode}
            onChange={onChangeRosterMode}
          />
          <p id={formationHelpId} className="mt-2 min-h-[18px] text-[12px] leading-4 text-[color:var(--text-subtle)]">
            {ROSTER_MODE_HELP[rosterMode]}
          </p>
        </>
      ) : null}

      {rosterMode === 'pool' ? (
        <div className="mt-4">
          <PlainAgentsPanel
            agentCount={poolAgentCount}
            onChangeAgentCount={onChangePoolAgentCount}
            cli={roleCliDefaults[SPRINT_ENGINE_GENERAL_ROLE_ID] ?? cliOptions[0]?.value ?? 'claude-code'}
            cliOptions={cliOptions}
            effectiveModel={effectiveRoleModel(SPRINT_ENGINE_GENERAL_ROLE_ID, roleModelOverrides)}
            onSetCli={(cli) => onSetRoleCli(SPRINT_ENGINE_GENERAL_ROLE_ID, cli)}
            onSetModel={(model) => onSetRoleModel(SPRINT_ENGINE_GENERAL_ROLE_ID, model)}
            {...(onSetRoleReasoning
              ? {
                  effectiveReasoning: effectiveRoleReasoning(SPRINT_ENGINE_GENERAL_ROLE_ID, roleReasoningOverrides),
                  onSetReasoning: (reasoning: string | null) =>
                    onSetRoleReasoning(SPRINT_ENGINE_GENERAL_ROLE_ID, reasoning),
                }
              : {})}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2.5">
            <RoleGlyphStack roles={onRoles} registry={registry} />
            <span className="text-[12px] tabular-nums text-[color:var(--text-muted)]">
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
                floored={sprintEngineRosterRoleFloor(role, roleCounts) > 0}
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
        </>
      )}
    </div>
  )
}

// Overlapping avatar stack summarizing the staffed roles, planner first-class.
function RoleGlyphStack({
  roles,
  registry,
}: {
  roles: SprintEngineRoleId[]
  registry: SprintEngineRoleRegistry | null
}) {
  if (roles.length === 0) {
    return <span className="text-[12px] text-[color:var(--text-disabled)]">No roles on</span>
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

// One dense roster row: glyph · name (+ Planner chip) over a full, untruncated
// description · full-width model chip · switch. Off roles stay visible but
// muted, with the runtime chip withheld (invisible keeps the columns aligned).
function RosterRoleRow({
  role,
  isOn,
  floored,
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
  /** The roster's last planner cannot be switched off (see sprintEngineRosterRoleFloor). */
  floored: boolean
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
        <span className="flex items-center gap-2">
          <span
            className={`text-[12.5px] ${
              isOn ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
            }`}
          >
            {label}
          </span>
          {isSprintEnginePlanningRole(role) ? (
            <span className="shrink-0 rounded border border-[color:var(--border-default)] px-1.5 text-[10px] font-semibold text-[color:var(--text-subtle)]">
              Planner
            </span>
          ) : null}
        </span>
        <span
          className={`mt-0.5 block text-[11px] leading-4 ${
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
        disabled={rosterDisabled || (isOn && floored)}
        onChange={(next) => onSetRoleCount(role, next ? 1 : 0)}
      />
    </div>
  )
}

// Quiet saved-rosters menu: load / save as new / update / rename / delete, all in
// one popover so the roster header stays a single line. "Custom" is the current
// unsaved config.
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
  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'

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
      surfaceClassName="w-[248px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="
            inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[color:var(--text-muted)]
            transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
            focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
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
          <input
            autoFocus
            type="text"
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
            className={`h-7 w-full rounded-[5px] border bg-[color:var(--bg-surface-raised)] px-2 text-[12px] text-[color:var(--text-default)] outline-none ${
              collides
                ? 'border-[color:var(--tone-error)]'
                : 'border-[color:var(--border-default)] focus:border-[color:var(--accent-primary)]'
            }`}
          />
          {collides ? (
            <span className="px-0.5 text-[11px] text-[color:var(--tone-error)]">
              A roster named “{trimmed}” already exists.
            </span>
          ) : null}
          <div className="flex items-center justify-end gap-1">
            <button type="button" onClick={close} className={`${itemClass} w-auto`}>
              Cancel
            </button>
            <PrimaryButton disabled={!canSubmit} onClick={submitName}>
              {editing === 'renaming' ? 'Rename' : 'Save'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <>
          {/* MC-1876: the built-in is pinned first and separated from saved
              rosters, because choosing it means "no roster" — not "a roster
              named No roles". It carries no staffing summary for the same
              reason, and offers no rename/delete. */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={noRolesSelected}
            className={itemClass}
            onClick={() => { onSelectRoster(NO_ROLES_ROSTER_ID); setOpen(false) }}
          >
            <span className="min-w-0 flex-1 truncate">{NO_ROLES_ROSTER_NAME}</span>
            {/* aria-checked on the radio already announces the choice. */}
            {noRolesSelected ? <CheckIcon className="icon-xs shrink-0" /> : null}
            <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">default</span>
          </button>
          <div className="my-1 border-t border-[color:var(--border-subtle)]" />
          {rosters.length > 0 ? (
            <>
              <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold text-[color:var(--text-subtle)]">
                Saved rosters
              </div>
              {selectedRoster ? (
                <button type="button" role="menuitem" className={itemClass} onClick={() => { onSelectRoster(null); setOpen(false) }}>
                  <span className="min-w-0 flex-1 truncate">Custom roster</span>
                </button>
              ) : null}
              {rosters.map((roster) => {
                const total = Object.values(roster.roleCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0)
                return (
                  <button
                    key={roster.id}
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      onSelectRoster(roster.id)
                      setOpen(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{roster.name}</span>
                    {/* Unlike the pinned "No roles" radio above, these rows are
                        plain menuitems: nothing else announces which one is in
                        use, so the mark carries its own name. */}
                    {roster.id === selectedRosterId ? (
                      <>
                        <CheckIcon className="icon-xs shrink-0" />
                        <span className="sr-only">Selected</span>
                      </>
                    ) : null}
                    <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
                      {total} role{total === 1 ? '' : 's'}
                    </span>
                  </button>
                )
              })}
              <div className="my-1 border-t border-[color:var(--border-subtle)]" />
            </>
          ) : null}
          <button type="button" role="menuitem" className={itemClass} onClick={() => setEditing('adding')}>
            Save as new roster…
          </button>
          {selectedRoster && selectedRosterDirty ? (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                onUpdateRoster(selectedRoster.id, selectedRoster.name)
                setOpen(false)
              }}
            >
              Update “{selectedRoster.name}”
            </button>
          ) : null}
          {selectedRoster ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  setName(selectedRoster.name)
                  setEditing('renaming')
                }}
              >
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${itemClass} text-[color:var(--tone-error)] hover:text-[color:var(--tone-error)]`}
                onClick={() => {
                  onDeleteRoster(selectedRoster.id)
                  setOpen(false)
                }}
              >
                Delete
              </button>
            </>
          ) : null}
        </>
      )}
    </Popover>
  )
}

// The plain-agents pool: how many agents share the run (bound to the
// concurrency cap, not a roster count) and which agent + model they all run.
// Moved here from WizardControls with the MC-1646 step split; behavior intact.
function PlainAgentsPanel({
  agentCount,
  onChangeAgentCount,
  cli,
  cliOptions,
  effectiveModel,
  effectiveReasoning,
  onSetCli,
  onSetModel,
  onSetReasoning,
}: {
  agentCount: number
  onChangeAgentCount?: (value: number) => void
  cli: AgentCli
  cliOptions: SprintEngineCliOption[]
  effectiveModel: string | undefined
  /** The pool's effort level. Opt-in as a pair with `onSetReasoning`. */
  effectiveReasoning?: string | undefined
  onSetCli: (cli: AgentCli) => void
  onSetModel?: (model: string | null) => void
  onSetReasoning?: (reasoning: string | null) => void
}) {
  const clamp = (value: number) => Math.max(1, Math.min(10, Math.floor(value)))
  const setCount = (value: number) => {
    if (onChangeAgentCount) onChangeAgentCount(clamp(value))
  }
  return (
    <div className="flex flex-col gap-2">
      <Field.Label>Agents</Field.Label>
      <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div className="flex items-start justify-between gap-3 px-3.5 py-3">
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">How many agents</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
              They share one task graph — each plans, builds, reviews, and tests its own work. More agents run at once and finish faster.
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <AgentCountStepButton
              label="Fewer agents"
              glyph="−"
              disabled={!onChangeAgentCount || agentCount <= 1}
              onClick={() => setCount(agentCount - 1)}
            />
            <span className="w-7 text-center text-[13px] font-semibold tabular-nums text-[color:var(--text-strong)]">
              {agentCount}
            </span>
            <AgentCountStepButton
              label="More agents"
              glyph="+"
              disabled={!onChangeAgentCount || agentCount >= 10}
              onClick={() => setCount(agentCount + 1)}
            />
          </div>
        </div>
        <div className="flex items-start justify-between gap-3 border-t border-[color:var(--border-default)] px-3.5 py-3">
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Agent</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
              The CLI and model every agent runs.
            </span>
          </span>
          {onSetModel ? (
            <CliModelPickerButton
              ariaLabel="Agent runtime"
              options={cliOptions}
              cli={cli}
              effectiveModelFor={(candidateCli) => (candidateCli === cli ? effectiveModel : undefined)}
              {...(onSetReasoning
                ? {
                    effectiveReasoningFor: (candidateCli: AgentCli) =>
                      candidateCli === cli ? effectiveReasoning : undefined,
                    onSelectReasoning: (_cli: AgentCli, reasoning: string | null) => onSetReasoning(reasoning),
                  }
                : {})}
              onSelectCli={onSetCli}
              onSelectModel={(nextCli, nextModel) => {
                if (nextCli !== cli) onSetCli(nextCli)
                onSetModel(nextModel)
              }}
            />
          ) : (
            <AgentCliPicker
              ariaLabel="Agent CLI"
              value={cli}
              disabled={false}
              cliOptions={cliOptions}
              onChange={onSetCli}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function AgentCountStepButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string
  glyph: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="
        inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--color-5)]
        bg-[color:var(--bg-surface-raised)] text-[14px] leading-none text-[color:var(--text-default)] transition-colors
        hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
        disabled:cursor-not-allowed disabled:opacity-45
      "
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}
