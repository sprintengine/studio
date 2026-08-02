// Leaf controls used by the creation hub and the Guided Brief build handoff.
// Extracted from NewWorkspacePanel.tsx so the hub orchestrator stays focused on
// step state and navigation; these row primitives are pure presentation and
// have no closure ties to the hub.
//
// The sprint wizard pages that once consumed these are gone (MC-2062: sprint
// creation is the New sprint dialog). RosterAndRunSettings remains as the
// Guided Brief build handoff's single-column roster + run-settings surface.

import React from 'react'
import type {
  AgentCli,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import { sprintEngineAutomationModeOptions } from '../../../utils/sprintengineAutomation'
import { Field, Select } from '../../ui'
import { SprintEngineRosterTable, type SprintEngineCliOption } from './SprintEngineRosterTable'

export const cliPermissionOptions: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  hint: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    hint: 'Use the agent’s default behavior. Agents ask before doing anything sensitive.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    hint: 'Fewer prompts, while keeping workspace-scoped guardrails where the agent supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    hint: 'Skip the agent’s permission prompts. Use only in projects and environments you trust.',
  },
]

export function CliPermissionPresetRow({
  preset,
  onChange,
}: {
  preset: SprintEngineCliPermissionPreset
  onChange: (preset: SprintEngineCliPermissionPreset) => void
}) {
  const current = cliPermissionOptions.find((option) => option.value === preset) ?? cliPermissionOptions[0]
  const isBypass = preset === 'bypass_all'
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-body font-semibold text-[color:var(--text-strong)]">Agent permissions</span>
          <span className="mt-0.5 block text-micro leading-4 text-[color:var(--text-muted)]">
            How spawned agents handle permission prompts.
          </span>
        </span>
        <Select<SprintEngineCliPermissionPreset>
          ariaLabel="Agent permission preset"
          items={cliPermissionOptions.map((option) => ({ value: option.value, label: option.label }))}
          value={preset}
          onChange={onChange}
          className="shrink-0"
        />
      </div>
      <p
        className={`text-micro leading-4 ${
          isBypass ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-muted)]'
        }`}
      >
        {current.hint}
      </p>
    </div>
  )
}

export function PathRadio({
  checked,
  label,
  hint,
  disabled,
  onSelect,
  dense,
}: {
  checked: boolean
  label: string
  hint: string
  disabled?: boolean
  onSelect: () => void
  // Tighter paddings for radios inside an already-carded settings block (the
  // run-settings Automation group), where the full card treatment is too tall.
  dense?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`
        grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-3 rounded-md border text-left
        ${dense ? 'px-2.5 py-2' : 'px-3.5 py-3'}
        transition-colors focus-visible:focus-ring
        disabled:cursor-not-allowed disabled:opacity-55
        ${checked
          ? 'border-[color:var(--color-6)] bg-[color:var(--bg-surface-raised)]'
          : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span
        className={`mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full border ${
          checked ? 'border-[color:var(--text-strong)] bg-[color:var(--text-strong)]' : 'border-[color:var(--color-6)]'
        }`}
        aria-hidden="true"
      >
        {/* design-tokens-allow: inner glyph of a custom radio control — not a status dot */}
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" /> : null}
      </span>
      <span className="min-w-0">
        <span className={`block text-body font-semibold ${checked ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
          {label}
        </span>
        <span className="mt-0.5 block text-micro leading-4 text-[color:var(--text-muted)]">{hint}</span>
      </span>
    </button>
  )
}

// The roster + run-settings surface of the Guided Brief build handoff: size the
// specialist roster, pick each role's runtime, and set how the run continues
// after the workspace opens. Rendered as one column inside the handoff card.
export function RosterAndRunSettings({
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
  totalAgents,
  rosterCountLabel,
  automationMode,
  onChangeAutomationMode,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
  workflowSection,
}: {
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  cliOptions: SprintEngineCliOption[]
  registry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
  countDisabled: boolean
  cliDisabled: boolean
  onSetCount: (role: SprintEngineRoleId, count: number) => void
  onSetCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  // Model-aware roster controls; optional so surfaces without launch semantics
  // stay as-is.
  roleModelOverrides?: SprintEngineRoleModelOverrides
  onSetModel?: (role: SprintEngineRoleId, model: string | null) => void
  totalAgents: number
  // Lets a host show "Loading roles" while the registry resolves; omit to show
  // the plain specialist count.
  rosterCountLabel?: string
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  // Optional panels rendered between the role table and the run-settings block,
  // so the surface reads work → workflow → run settings in the plan's order.
  workflowSection?: React.ReactNode
}) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <Field.Label>Roster</Field.Label>
          <span className="text-micro tabular-nums text-[color:var(--text-muted)]">
            {rosterCountLabel ?? `${totalAgents} specialist${totalAgents === 1 ? '' : 's'}`}
          </span>
        </div>
        <SprintEngineRosterTable
          roleCounts={roleCounts}
          roleCliDefaults={roleCliDefaults}
          cliOptions={cliOptions}
          registry={registry}
          disabledRoleIds={disabledRoleIds}
          countDisabled={countDisabled}
          cliDisabled={cliDisabled}
          onSetCount={onSetCount}
          onSetCli={onSetCli}
          roleModelOverrides={roleModelOverrides}
          onSetModel={onSetModel}
        />
      </div>

      {workflowSection}

      <div className="flex flex-col gap-2">
        <Field.Label>Run settings</Field.Label>
        <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <CliPermissionPresetRow
            preset={cliPermissionPreset}
            onChange={onChangeCliPermissionPreset}
          />
          <div className="flex flex-col gap-2 border-t border-[color:var(--border-default)] px-3.5 py-3">
            <div>
              <span className="block text-body font-semibold text-[color:var(--text-strong)]">Automation</span>
              <span className="mt-0.5 block text-micro leading-4 text-[color:var(--text-muted)]">
                How the sprint should continue after this workspace opens.
              </span>
            </div>
            <div className="grid gap-1.5" role="radiogroup" aria-label="Sprint automation mode">
              {sprintEngineAutomationModeOptions.map((option) => (
                <PathRadio
                  key={option.value}
                  checked={automationMode === option.value}
                  label={option.label}
                  hint={option.hint}
                  onSelect={() => onChangeAutomationMode(option.value)}
                  dense
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
