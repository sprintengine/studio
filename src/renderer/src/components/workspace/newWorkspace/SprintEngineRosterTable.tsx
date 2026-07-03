import React from 'react'

import CliIcon from '../../CliIcon'
import { CliModelPickerButton, Popover, RoleAvatar, Tooltip } from '../../ui'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  getSprintEngineWizardRoleSummary,
  listSprintEngineWizardRoles,
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

// Planning roles are marked so the row can badge them; the panel's enable
// handler keeps at least one planner on the team (`sprintEngineRosterRoleFloor`).
const PLANNER_ROLE_IDS: ReadonlySet<string> = new Set(['architect', 'general'])

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
        const controls = isAdded ? (
          <div className="flex shrink-0 items-center gap-2 py-2 pr-2">
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
        ) : null
        return (
          <div
            key={role}
            className={`group relative flex items-stretch gap-2 border-l-2 transition-colors ${
              isAdded
                ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                : 'border-transparent hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <button
              type="button"
              aria-pressed={isAdded}
              disabled={countDisabled}
              aria-label={isAdded ? `${label} — in the team, activate to remove` : `${label} — add to the team`}
              onClick={() => {
                if (!countDisabled) onSetCount(role, isAdded ? 0 : 1)
              }}
              className="
                flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors
                focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)]
                disabled:cursor-not-allowed
              "
            >
              <RoleAvatar role={role} registry={registry} size="md" ariaLabel="" className={isAdded ? undefined : 'opacity-55'} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-[12px] font-medium ${isAdded ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
                    {label}
                  </span>
                  {PLANNER_ROLE_IDS.has(role) ? (
                    <span className="shrink-0 rounded border border-[color:var(--border-default)] px-1 text-[9px] font-semibold text-[color:var(--text-subtle)]">
                      Planner
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-muted)]">{summary}</span>
              </span>
              {!isAdded ? (
                <span
                  aria-hidden="true"
                  className="shrink-0 pr-1 text-[11px] font-semibold text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100"
                >
                  + Add
                </span>
              ) : null}
            </button>
            {controls}
          </div>
        )
      })}
      {footer}
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
