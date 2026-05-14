import CliIcon from '../../CliIcon'
import { InboxRow, Select, type SelectItem } from '../../ui'
import {
  sprintEngineRoleLabels,
  sprintEngineRoleOrder,
} from '../../../utils/sprintengine'
import type {
  AgentCli,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
} from '../../../types/workspace'

const roleSummaries: Record<SprintEngineRole, string> = {
  architect: 'Plans the work, owns dependencies, gates reviews.',
  product: 'Clarifies scope, tradeoffs, and acceptance criteria.',
  frontend: 'Implements UI, interaction states, and polish.',
  developer: 'Builds core logic, integrations, and refactors.',
  code_reviewer: 'Reviews implementation quality before validation.',
  spec_reviewer: 'Checks implementation against requirements and acceptance criteria.',
  performance: 'Reviews latency, runtime cost, and measurement gaps.',
  tester: 'Runs acceptance checks and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, and abuse cases.',
}

const cliOptions: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
]

interface RosterTableProps {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  disabled: boolean
  onSetCount: (role: SprintEngineRole, count: number) => void
  onSetCli: (role: SprintEngineRole, cli: AgentCli) => void
}

export function SprintEngineRosterTable({
  roleCounts,
  roleCliDefaults,
  disabled,
  onSetCount,
  onSetCli,
}: RosterTableProps) {
  return (
    <div className="divide-y divide-[color:var(--border-default)] rounded-md border border-[color:var(--border-default)]">
      {sprintEngineRoleOrder.map((role) => {
        const isAdded = role === 'architect' || roleCounts[role] > 0
        const trailing = isAdded ? (
          <div className="flex items-center gap-2">
            <CountStepper
              role={role}
              count={roleCounts[role]}
              disabled={disabled}
              onSetCount={onSetCount}
            />
            <CliPicker
              role={role}
              value={roleCliDefaults[role]}
              disabled={disabled}
              onChange={onSetCli}
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
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
            title={sprintEngineRoleLabels[role]}
            supporting={isAdded ? roleSummaries[role] : undefined}
            trailing={trailing}
          />
        )
      })}
    </div>
  )
}

function CountStepper({
  role,
  count,
  disabled,
  onSetCount,
}: {
  role: SprintEngineRole
  count: number
  disabled: boolean
  onSetCount: (role: SprintEngineRole, count: number) => void
}) {
  const minCount = role === 'architect' ? 1 : 0
  const decDisabled = disabled || count <= minCount
  const incDisabled = disabled || count >= 10
  return (
    <div className="flex h-7 items-center overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)]">
      <button
        type="button"
        aria-label={`Decrease ${sprintEngineRoleLabels[role]} count`}
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
        aria-label={`Increase ${sprintEngineRoleLabels[role]} count`}
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
  value,
  disabled,
  onChange,
}: {
  role: SprintEngineRole
  value: AgentCli
  disabled: boolean
  onChange: (role: SprintEngineRole, cli: AgentCli) => void
}) {
  const items: SelectItem<AgentCli>[] = cliOptions.map((option) => ({
    value: option.value,
    label: option.label,
  }))
  return (
    <div className="flex items-center gap-2">
      <CliIcon cli={value} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
      <Select<AgentCli>
        ariaLabel={`${sprintEngineRoleLabels[role]} CLI`}
        items={items}
        value={value}
        onChange={(next) => onChange(role, next)}
        disabled={disabled}
        className="w-[140px]"
      />
    </div>
  )
}
