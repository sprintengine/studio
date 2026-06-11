// Leaf controls used by the new-workspace wizard. Extracted from
// NewWorkspacePanel.tsx so the wizard orchestrator stays focused on step
// state and navigation; these row primitives are pure presentation and have
// no closure ties to the wizard reducer.

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
    hint: 'Use the CLI default permission behavior. Agents will prompt before sensitive actions.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    hint: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    hint: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
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
          <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Agent permissions</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
            How spawned agents handle CLI permission prompts.
          </span>
        </span>
        <Select<SprintEngineCliPermissionPreset>
          ariaLabel="CLI permission preset"
          items={cliPermissionOptions.map((option) => ({ value: option.value, label: option.label }))}
          value={preset}
          onChange={onChange}
          className="shrink-0"
        />
      </div>
      <p
        className={`text-[11px] leading-4 ${
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
}: {
  checked: boolean
  label: string
  hint: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`
        grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-3 rounded-md border px-3.5 py-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
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
        <span className={`block text-[13px] font-semibold ${checked ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">{hint}</span>
      </span>
    </button>
  )
}

// The roster + run-settings surface shared by the Sprint Engine wizard step and
// the Guided Brief build handoff. Both let the user size the specialist roster,
// pick each role's default CLI, and set how the run continues after the
// workspace opens — keeping one component means the two entry points cannot
// drift in layout, copy, or width.
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
  cliModelDefaults,
  onSetModel,
  spawnAtStartRoles,
  onSetSpawnAtStart,
  totalAgents,
  rosterCountLabel,
  saveRoster,
  onChangeSaveRoster,
  automationMode,
  onChangeAutomationMode,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
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
  // Model-aware roster controls and per-role "start now" intent; optional so
  // surfaces without launch semantics (Guided Brief handoff) stay as-is.
  roleModelOverrides?: SprintEngineRoleModelOverrides
  cliModelDefaults?: Partial<Record<AgentCli, string>>
  onSetModel?: (role: SprintEngineRoleId, model: string | null) => void
  spawnAtStartRoles?: Partial<Record<SprintEngineRoleId, boolean>>
  onSetSpawnAtStart?: (role: SprintEngineRoleId, spawn: boolean) => void
  totalAgents: number
  // Lets the Sprint Engine step show "Loading roles" while the registry resolves;
  // omit to show the plain specialist count.
  rosterCountLabel?: string
  // When the handler is provided, a "save as default" affordance is hung off the
  // bottom of the roster. Omitted by the Guided Brief handoff, which has no
  // saved-roster preference to set.
  saveRoster?: boolean
  onChangeSaveRoster?: (save: boolean) => void
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Field.Label>Roster</Field.Label>
          <span className="text-[11px] tabular-nums text-[color:var(--text-muted)]">
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
          cliModelDefaults={cliModelDefaults}
          onSetModel={onSetModel}
          spawnAtStartRoles={spawnAtStartRoles}
          onSetSpawnAtStart={onSetSpawnAtStart}
          footer={
            onChangeSaveRoster ? (
              <SaveRosterDefaultRow checked={saveRoster ?? false} onChange={onChangeSaveRoster} />
            ) : null
          }
        />
      </div>

      <div className="flex flex-col gap-2">
        <Field.Label>Run settings</Field.Label>
        <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <CliPermissionPresetRow
            preset={cliPermissionPreset}
            onChange={onChangeCliPermissionPreset}
          />
          <div className="flex flex-col gap-2 border-t border-[color:var(--border-default)] px-3.5 py-3">
            <div>
              <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Automation</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                How Sprint Engine should continue after this workspace opens.
              </span>
            </div>
            <div className="grid gap-2" role="radiogroup" aria-label="Sprint Engine automation mode">
              {sprintEngineAutomationModeOptions.map((option) => (
                <PathRadio
                  key={option.value}
                  checked={automationMode === option.value}
                  label={option.label}
                  hint={option.hint}
                  onSelect={() => onChangeAutomationMode(option.value)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// Quiet "make this the default" affordance that hangs off the bottom of the
// roster, hairline-divided below the role rows. It deliberately reads as a
// trailing action on the list it persists — not as a separate card above it.
function SaveRosterDefaultRow({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 border-l-2 border-transparent px-3 py-2.5 text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-[color:var(--accent-primary)]"
      />
      Save as the default roster for new workspaces
    </label>
  )
}
