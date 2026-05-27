import CliIcon from '../../CliIcon'
import { InboxRow, Select, type SelectItem } from '../../ui'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  getSprintEngineWizardRoleSummary,
  listSprintEngineAddableRoles,
} from '../../../utils/sprintengineRoleOptions'
import type {
  AgentCli,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'

export type SprintEngineCliOption = { value: AgentCli; label: string }

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
}: RosterTableProps) {
  const roles = listSprintEngineAddableRoles(registry, disabledRoleIds)
  const fallbackCli = cliOptions[0]?.value ?? 'claude'
  return (
    <div className="divide-y divide-[color:var(--border-default)] rounded-md border border-[color:var(--border-default)]">
      {roles.map((role) => {
        const count = roleCounts[role] ?? 0
        const isAdded = role === 'architect' || count > 0
        const label = getSprintEngineRoleLabel(role, registry)
        const summary = getSprintEngineWizardRoleSummary(role, registry)
        const trailing = isAdded ? (
          <div className="flex items-center gap-2">
            <CountStepper
              role={role}
              label={label}
              count={count}
              disabled={countDisabled}
              onSetCount={onSetCount}
            />
            <CliPicker
              role={role}
              label={label}
              value={roleCliDefaults[role] ?? fallbackCli}
              disabled={cliDisabled}
              cliOptions={cliOptions}
              onChange={onSetCli}
            />
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
            supporting={isAdded ? summary : undefined}
            trailing={trailing}
          />
        )
      })}
    </div>
  )
}

function CountStepper({
  role,
  label,
  count,
  disabled,
  onSetCount,
}: {
  role: SprintEngineRoleId
  label: string
  count: number
  disabled: boolean
  onSetCount: (role: SprintEngineRoleId, count: number) => void
}) {
  const minCount = role === 'architect' ? 1 : 0
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
  const options = cliOptions.some((option) => option.value === value)
    ? cliOptions
    : [{ value, label: value }, ...cliOptions]
  const items: SelectItem<AgentCli>[] = options.map((option) => ({
    value: option.value,
    label: option.label,
  }))
  return (
    <div className="flex items-center gap-2">
      <CliIcon cli={value} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
      <Select<AgentCli>
        ariaLabel={`${label} CLI`}
        items={items}
        value={value}
        onChange={(next) => onChange(role, next)}
        disabled={disabled}
        className="w-[140px]"
      />
    </div>
  )
}
