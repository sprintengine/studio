import React from 'react'

import { CliModelPickerButton, RoleAvatar, Select, type SelectItem } from '../../ui'
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
              <AgentCliSelect
                ariaLabel={`${label} CLI`}
                value={roleCli}
                disabled={cliDisabled}
                cliOptions={cliOptions}
                onChange={(cli) => onSetCli(role, cli)}
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
                focus-visible:focus-ring-inset
                disabled:cursor-not-allowed
              "
            >
              <RoleAvatar role={role} registry={registry} size="md" ariaLabel="" className={isAdded ? undefined : 'opacity-55'} />
              <span className="min-w-0 flex-1">
                {/* No role is badged as the one that plans: every sprint
                    coordinates through a seat, so there is nothing to mark
                    here and nothing floored on (MC-2055). */}
                <span className={`block truncate text-meta font-medium ${isAdded ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
                  {label}
                </span>
                <span className="mt-0.5 block truncate text-meta text-[color:var(--text-muted)]">{summary}</span>
              </span>
              {!isAdded ? (
                <span
                  aria-hidden="true"
                  className="shrink-0 pr-1 text-micro font-semibold text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
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

// The CLI-only value picker for a row without model selection: the kit's
// `Select` — a select-only combobox with the arrow-key, Home/End, type-ahead
// and Escape contract every value picker in the app shares. It replaced a
// hand-rolled `Popover` listbox whose option rows had no focus ring, no
// keyboard model, a text `▾` glyph and a raw `rgba()` hover tint (audit,
// menus-and-listboxes-rebuilt-without-a-keyboard-model). `Select` has no
// leading-node slot, so the option is its label alone; the CLI mark still
// shows on the model-aware picker beside it.
//
// A value the catalogue no longer lists (a plugin that was removed after the
// default was saved) is kept as a labelled option rather than dropped, so the
// trigger never shows a blank for a CLI the roster still names.
export function AgentCliSelect({
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
  const items: SelectItem<AgentCli>[] = React.useMemo(() => {
    const listed = cliOptions.map((option) => ({ value: option.value, label: option.label }))
    return cliOptions.some((option) => option.value === value)
      ? listed
      : [{ value, label: value }, ...listed]
  }, [cliOptions, value])
  return (
    <Select<AgentCli>
      ariaLabel={ariaLabel}
      items={items}
      value={value}
      disabled={disabled}
      onChange={onChange}
      className="shrink-0"
    />
  )
}
