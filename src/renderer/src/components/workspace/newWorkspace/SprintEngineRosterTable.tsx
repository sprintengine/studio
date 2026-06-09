import React from 'react'

import CliIcon from '../../CliIcon'
import { InboxRow, Popover, Tooltip } from '../../ui'
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
  footer,
}: RosterTableProps) {
  const roles = listSprintEngineAddableRoles(registry, disabledRoleIds)
  const fallbackCli = cliOptions[0]?.value ?? 'claude-code'
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
