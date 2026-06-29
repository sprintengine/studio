import React from 'react'

import CliIcon from '../../CliIcon'
import { CliModelPickerButton, InboxRow, Popover, Tooltip } from '../../ui'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  getSprintEngineWizardRoleSummary,
  listSprintEngineWizardRoles,
  sprintEngineRosterRoleFloor,
} from '../../../utils/sprintengineRoleOptions'
import type {
  AgentCli,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import type { PluginModelCatalog } from '../../../../../shared/plugin-manifest'

export type SprintEngineCliOption = {
  value: AgentCli
  label: string
  // Present when the plugin declares model selection; enables the per-role
  // model sublist in the roster runtime picker.
  modelSelection?: PluginModelCatalog
}

interface RosterTableProps {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  cliOptions: SprintEngineCliOption[]
  registry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
  countDisabled: boolean
  cliDisabled: boolean
  onSetCount: (role: SprintEngineRoleId, count: number) => void
  onSetCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  // Model-aware roster controls. When `onSetModel` is provided the CLI picker
  // expands per-CLI model sublists; the override map determines the effective
  // model shown (string = explicit id, null/absent = CLI default).
  roleModelOverrides?: SprintEngineRoleModelOverrides
  onSetModel?: (role: SprintEngineRoleId, model: string | null) => void
  // "Start now" launch intent per role. When `onSetSpawnAtStart` is provided,
  // each added role row gets a checkbox marking its agents for an explicit
  // spawn when the workspace opens.
  spawnAtStartRoles?: Partial<Record<SprintEngineRoleId, boolean>>
  spawnAtStartLocked?: boolean
  onSetSpawnAtStart?: (role: SprintEngineRoleId, spawn: boolean) => void
  /** Optional trailing row rendered inside the roster border, hairline-divided
   *  below the role rows (e.g. the "save as default" affordance). */
  footer?: React.ReactNode
}

export function SprintEngineRosterTable({
  roleCounts,
  roleCliDefaults,
  cliOptions,
  registry,
  disabledRoleIds,
  countDisabled,
  cliDisabled,
  onSetCount,
  onSetCli,
  roleModelOverrides,
  onSetModel,
  spawnAtStartRoles,
  spawnAtStartLocked = false,
  onSetSpawnAtStart,
  footer,
}: RosterTableProps) {
  const roles = listSprintEngineWizardRoles(registry, disabledRoleIds)
  const fallbackCli = cliOptions[0]?.value ?? 'claude-code'
  return (
    <div className="divide-y divide-[color:var(--border-default)] rounded-md border border-[color:var(--border-default)]">
      {roles.map((role) => {
        const count = roleCounts[role] ?? 0
        const isAdded = count > 0
        const label = getSprintEngineRoleLabel(role, registry)
        const summary = getSprintEngineWizardRoleSummary(role, registry)
        const roleCli = roleCliDefaults[role] ?? fallbackCli
        const trailing = isAdded ? (
          <div className="flex items-center gap-2">
            <CountStepper
              role={role}
              label={label}
              count={count}
              minCount={sprintEngineRosterRoleFloor(role, roleCounts)}
              disabled={countDisabled}
              onSetCount={onSetCount}
            />
            {onSetModel ? (
              <RoleRuntimePicker
                role={role}
                label={label}
                cli={roleCli}
                disabled={cliDisabled}
                cliOptions={cliOptions}
                roleModelOverrides={roleModelOverrides}
                onSetCli={onSetCli}
                onSetModel={onSetModel}
              />
            ) : (
              <CliPicker
                role={role}
                label={label}
                value={roleCli}
                disabled={cliDisabled}
                cliOptions={cliOptions}
                onChange={onSetCli}
              />
            )}
            {onSetSpawnAtStart ? (
              <Tooltip content={spawnAtStartLocked ? 'This role is controlled by the selected run settings.' : `Start ${label} agents when the workspace opens`}>
                <button
                  type="button"
                  aria-pressed={spawnAtStartRoles?.[role] ?? false}
                  aria-disabled={spawnAtStartLocked}
                  aria-label={`Start ${label} agents when the workspace opens`}
                  onClick={() => {
                    if (!spawnAtStartLocked) onSetSpawnAtStart(role, !(spawnAtStartRoles?.[role] ?? false))
                  }}
                  className={`
                    interactive inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition-colors
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                    ${(spawnAtStartRoles?.[role] ?? false)
                      ? `border-[color:var(--accent-primary-soft)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)] ${spawnAtStartLocked ? 'cursor-default' : ''}`
                      : 'border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                    }
                  `}
                >
                  <span
                    aria-hidden="true"
                    className={`
                      inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors
                      ${(spawnAtStartRoles?.[role] ?? false)
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--bg-base)]'
                        : 'border-[color:var(--text-disabled)] text-transparent'
                      }
                    `}
                  >
                    <span className="ml-[1px] text-[8px] leading-none">▶</span>
                  </span>
                  Start
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            disabled={countDisabled}
            onClick={() => onSetCount(role, 1)}
            className="
              inline-flex h-7 items-center gap-1.5 rounded border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)] px-2
              text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors
              hover:border-[color:var(--accent-primary)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              disabled:cursor-not-allowed disabled:opacity-55
            "
          >
            <span aria-hidden="true">+</span>
            Add
          </button>
        )
        return (
          <InboxRow
            key={role}
            tone={isAdded ? 'accent' : 'neutral'}
            title={label}
            supporting={summary}
            trailing={trailing}
          />
        )
      })}
      {footer}
    </div>
  )
}

function CountStepper({
  role,
  label,
  count,
  minCount,
  disabled,
  onSetCount,
}: {
  role: SprintEngineRoleId
  label: string
  count: number
  // Per-row floor. Planning roles (architect/general) floor at 1 while they are
  // the sole staffed planner; every other role floors at 0. Computed by the
  // caller via `sprintEngineRosterRoleFloor` so the rule lives in one place.
  minCount: number
  disabled: boolean
  onSetCount: (role: SprintEngineRoleId, count: number) => void
}) {
  const decDisabled = disabled || count <= minCount
  const incDisabled = disabled || count >= 10
  return (
    <div className="flex h-7 items-center overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)]">
      <button
        type="button"
        aria-label={`Decrease ${label} count`}
        disabled={decDisabled}
        onClick={() => onSetCount(role, count - 1)}
        className="
          h-7 w-7 text-[color:var(--text-muted)] transition-colors
          hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
          disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]
        "
      >
        -
      </button>
      <span className="w-6 text-center text-[12px] font-semibold tabular-nums text-[color:var(--text-strong)]">
        {count}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label} count`}
        disabled={incDisabled}
        onClick={() => onSetCount(role, count + 1)}
        className="
          h-7 w-7 text-[color:var(--text-muted)] transition-colors
          hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
          disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]
        "
      >
        +
      </button>
    </div>
  )
}

// Effective launch model for a role row: explicit override (string), otherwise
// CLI default (undefined -> no model flag).
function effectiveRoleModel(
  role: SprintEngineRoleId,
  roleModelOverrides: SprintEngineRoleModelOverrides | undefined,
): string | undefined {
  const override = roleModelOverrides?.[role]
  if (override === null) return undefined
  if (override) return override
  return undefined
}

// Model-aware runtime picker for a roster role row: the shared CLI+model
// picker button with role-scoped override semantics.
function RoleRuntimePicker({
  role,
  label,
  cli,
  disabled,
  cliOptions,
  roleModelOverrides,
  onSetCli,
  onSetModel,
}: {
  role: SprintEngineRoleId
  label: string
  cli: AgentCli
  disabled: boolean
  cliOptions: SprintEngineCliOption[]
  roleModelOverrides?: SprintEngineRoleModelOverrides
  onSetCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetModel: (role: SprintEngineRoleId, model: string | null) => void
}) {
  return (
    <CliModelPickerButton
      ariaLabel={`${label} agent runtime`}
      options={cliOptions}
      cli={cli}
      disabled={disabled}
      effectiveModelFor={(candidateCli) =>
        candidateCli === cli ? effectiveRoleModel(role, roleModelOverrides) : undefined
      }
      onSelectCli={(nextCli) => onSetCli(role, nextCli)}
      onSelectModel={(nextCli, nextModel) => {
        if (nextCli !== cli) onSetCli(role, nextCli)
        onSetModel(role, nextModel)
      }}
    />
  )
}

function CliPicker({
  role,
  label,
  value,
  disabled,
  cliOptions,
  onChange,
}: {
  role: SprintEngineRoleId
  label: string
  value: AgentCli
  disabled: boolean
  cliOptions: SprintEngineCliOption[]
  onChange: (role: SprintEngineRoleId, cli: AgentCli) => void
}) {
  return (
    <AgentCliPicker
      ariaLabel={`${label} CLI`}
      value={value}
      disabled={disabled}
      cliOptions={cliOptions}
      onChange={(cli) => onChange(role, cli)}
    />
  )
}

export function AgentCliPicker({
  ariaLabel,
  value,
  disabled,
  cliOptions,
  onChange,
}: {
  ariaLabel: string
  value: AgentCli
  disabled: boolean
  cliOptions: SprintEngineCliOption[]
  onChange: (cli: AgentCli) => void
}) {
  const [open, setOpen] = React.useState(false)
  const options = cliOptions.some((option) => option.value === value)
    ? cliOptions
    : [{ value, label: value }, ...cliOptions]
  const selected = options.find((option) => option.value === value) ?? options[0]
  if (!selected) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="listbox"
      placement="bottom-end"
      className="shrink-0"
      surfaceClassName="w-[180px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={`Agent CLI: ${selected.label}`} wrapperClassName="inline-flex">
          <button
            ref={ref}
            type="button"
            aria-label={`${ariaLabel}: ${selected.label}`}
            disabled={disabled}
            onClick={togglePopover}
            className="
              interactive inline-flex h-7 min-w-[140px] items-center justify-between gap-2 rounded-md border border-[color:var(--color-5)]
              bg-[color:var(--bg-surface-raised)] px-2 text-left text-[12px] text-[color:var(--text-default)] transition-colors
              hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              disabled:cursor-not-allowed disabled:opacity-45
            "
            {...triggerProps}
          >
            <span className="flex min-w-0 items-center gap-2">
              <CliIcon cli={selected.value} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
              <span className="truncate">{selected.label}</span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-[10px] text-[color:var(--text-disabled)]">▾</span>
          </button>
        </Tooltip>
      )}
    >
      {options.map((option) => {
        const isCurrent = option.value === selected.value
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={isCurrent}
            onClick={() => {
              onChange(option.value)
              setOpen(false)
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
              isCurrent
                ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
            }`}
          >
            <CliIcon cli={option.value} className="icon-sm shrink-0" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {isCurrent ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
          </button>
        )
      })}
    </Popover>
  )
}
