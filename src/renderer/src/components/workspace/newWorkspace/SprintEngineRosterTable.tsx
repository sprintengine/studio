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
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import type { PluginModelCatalog, PluginReasoningCatalog } from '../../../../../shared/plugin-manifest'

export type SprintEngineCliOption = {
  value: AgentCli
  label: string
  // Present when the plugin declares model selection; enables the per-role
  // model sublist in the roster runtime picker.
  modelSelection?: PluginModelCatalog
  // Present when the plugin declares reasoning levels; a CLI without it shows
  // no effort control on any roster row (MC-1885).
  reasoningSelection?: PluginReasoningCatalog
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
  // Per-role reasoning-effort level (MC-1885). Opt-in as a pair, on top of the
  // model-aware controls above: a host that passes neither renders no effort
  // control rather than one it cannot persist.
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides
  onSetReasoning?: (role: SprintEngineRoleId, reasoning: string | null) => void
  /** Optional trailing row rendered inside the roster border, hairline-divided
   *  below the role rows (e.g. the "save as default" affordance). */
  footer?: React.ReactNode
  /** MC-1542 "Work types & models" panel mode: the row copy reads as turning
   *  work on, not hiring an agent. Off (default) keeps the classic team-roster
   *  presentation. */
  workTypes?: boolean
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
  roleReasoningOverrides,
  onSetReasoning,
  footer,
  workTypes,
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
                roleReasoningOverrides={roleReasoningOverrides}
                onSetCli={onSetCli}
                onSetModel={onSetModel}
                onSetReasoning={onSetReasoning}
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
          </div>
        ) : null
        return (
          <div
            key={role}
            className={`group relative flex items-stretch gap-2 transition-colors ${
              isAdded
                ? 'bg-[color:var(--bg-selected)]'
                : 'hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <button
              type="button"
              aria-pressed={isAdded}
              disabled={countDisabled}
              aria-label={
                workTypes
                  ? isAdded
                    ? `${label} — included in this run, activate to remove`
                    : `${label} — include this kind of work`
                  : isAdded
                    ? `${label} — in the team, activate to remove`
                    : `${label} — add to the team`
              }
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
                    <span className="shrink-0 rounded border border-[color:var(--border-default)] px-1.5 text-[10px] font-semibold text-[color:var(--text-subtle)]">
                      Planner
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-muted)]">{summary}</span>
              </span>
              {!isAdded ? (
                <span
                  aria-hidden="true"
                  className="shrink-0 pr-1 text-[11px] font-semibold text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
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

// Effective effort level for a role row: an explicit level, otherwise undefined
// (the CLI's own default effort -> no flag). Mirrors effectiveRoleModel.
function effectiveRoleReasoning(
  role: SprintEngineRoleId,
  roleReasoningOverrides: SprintEngineRoleReasoningOverrides | undefined,
): string | undefined {
  const override = roleReasoningOverrides?.[role]
  if (override === null) return undefined
  return override || undefined
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
  roleReasoningOverrides,
  onSetCli,
  onSetModel,
  onSetReasoning,
}: {
  role: SprintEngineRoleId
  label: string
  cli: AgentCli
  disabled: boolean
  cliOptions: SprintEngineCliOption[]
  roleModelOverrides?: SprintEngineRoleModelOverrides
  roleReasoningOverrides?: SprintEngineRoleReasoningOverrides
  onSetCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetModel: (role: SprintEngineRoleId, model: string | null) => void
  onSetReasoning?: (role: SprintEngineRoleId, reasoning: string | null) => void
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
      {...(onSetReasoning
        ? {
            effectiveReasoningFor: (candidateCli: AgentCli) =>
              candidateCli === cli ? effectiveRoleReasoning(role, roleReasoningOverrides) : undefined,
            onSelectReasoning: (_cli: AgentCli, reasoning: string | null) => onSetReasoning(role, reasoning),
          }
        : {})}
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
                ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
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
