import CliIcon from '../../CliIcon'
import {
  sprintEngineRoleAccent,
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
    <div className="overflow-hidden rounded-md border border-[#24252b]">
      {sprintEngineRoleOrder.map((role, index) => {
        const isAdded = role === 'architect' || roleCounts[role] > 0
        return (
          <div
            key={role}
            className={`grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 ${
              index > 0 ? 'border-t border-[#1f2025]' : ''
            } ${isAdded ? '' : 'bg-[#0a0b0e]'}`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${isAdded ? '' : 'opacity-40'}`}
              style={{ backgroundColor: sprintEngineRoleAccent[role] }}
            />
            <div className="min-w-0">
              <div
                className={`truncate text-[13px] font-semibold ${
                  isAdded ? 'text-[#ececee]' : 'text-[#777780]'
                }`}
              >
                {sprintEngineRoleLabels[role]}
              </div>
              {isAdded ? (
                <div className="mt-0.5 truncate text-[11px] leading-4 text-[#9a9aa2]">
                  {roleSummaries[role]}
                </div>
              ) : null}
            </div>
            {isAdded ? (
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
                  inline-flex h-7 items-center gap-1.5 rounded border border-[#303139] bg-[#111216] px-2
                  text-[11px] font-semibold text-[#a8a8b0] transition-colors
                  hover:border-[#5c7cff]/40 hover:bg-[#17181d] hover:text-[#d4ddff]
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60
                  disabled:cursor-not-allowed disabled:opacity-55
                "
              >
                <span aria-hidden="true">+</span>
                Add
              </button>
            )}
          </div>
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
    <div className="flex h-7 items-center overflow-hidden rounded-md border border-[#303139] bg-[#111216]">
      <button
        type="button"
        aria-label={`Decrease ${sprintEngineRoleLabels[role]} count`}
        disabled={decDisabled}
        onClick={() => onSetCount(role, count - 1)}
        className="
          h-7 w-7 text-[#9a9aa2] transition-colors
          hover:bg-[#17181d] hover:text-[#ececee]
          disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]
        "
      >
        -
      </button>
      <span className="w-6 text-center text-[12px] font-semibold tabular-nums text-[#ececee]">
        {count}
      </span>
      <button
        type="button"
        aria-label={`Increase ${sprintEngineRoleLabels[role]} count`}
        disabled={incDisabled}
        onClick={() => onSetCount(role, count + 1)}
        className="
          h-7 w-7 text-[#9a9aa2] transition-colors
          hover:bg-[#17181d] hover:text-[#ececee]
          disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]
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
  return (
    <label className="relative">
      <span className="sr-only">{sprintEngineRoleLabels[role]} CLI</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(role, event.target.value as AgentCli)}
        className="
          h-7 w-[112px] appearance-none rounded-md border border-[#303139] bg-[#111216] py-0 pl-7 pr-6
          text-[12px] font-semibold text-[#d7d7dc] outline-none transition-colors
          hover:bg-[#17181d] focus:border-[#ececee]/70
          disabled:cursor-not-allowed disabled:text-[#5a5a63]
        "
      >
        {cliOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#8a8a92]">
        <CliIcon cli={value} className="h-3.5 w-3.5" />
      </span>
      <svg
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#5a5a63]"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 7.5L10 12.5L15 7.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  )
}
