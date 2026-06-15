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
  SprintEngineRosterTeam,
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
  onSetModel,
  spawnAtStartRoles,
  spawnAtStartLocked,
  onSetSpawnAtStart,
  totalAgents,
  rosterCountLabel,
  saveRoster,
  onChangeSaveRoster,
  teams,
  selectedTeamId,
  onSelectTeam,
  onSaveTeam,
  onUpdateTeam,
  onDeleteTeam,
  automationMode,
  onChangeAutomationMode,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
  useWorktrees,
  onChangeUseWorktrees,
  worktreesDisabled,
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
  onSetModel?: (role: SprintEngineRoleId, model: string | null) => void
  spawnAtStartRoles?: Partial<Record<SprintEngineRoleId, boolean>>
  spawnAtStartLocked?: boolean
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
  // Named roster teams. When `onSelectTeam` is provided, a team picker is shown
  // above the roster and a "save as team" affordance replaces the plain default
  // checkbox. Omitted by the Guided Brief handoff.
  teams?: SprintEngineRosterTeam[]
  selectedTeamId?: string | null
  onSelectTeam?: (id: string | null) => void
  onSaveTeam?: (name: string) => void
  onUpdateTeam?: (id: string, name: string) => void
  onDeleteTeam?: (id: string) => void
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  // Worktree mode toggle. Omitted by the Guided Brief handoff, which has no
  // separate run-options surface.
  useWorktrees?: boolean
  onChangeUseWorktrees?: (value: boolean) => void
  worktreesDisabled?: boolean
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
        {onSelectTeam && (teams?.length ?? 0) > 0 ? (
          <RosterTeamPicker
            teams={teams ?? []}
            selectedTeamId={selectedTeamId ?? null}
            onSelectTeam={onSelectTeam}
          />
        ) : null}
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
          spawnAtStartRoles={spawnAtStartRoles}
          spawnAtStartLocked={spawnAtStartLocked}
          onSetSpawnAtStart={onSetSpawnAtStart}
          footer={
            onSaveTeam ? (
              <SaveRosterTeamRow
                teams={teams ?? []}
                selectedTeamId={selectedTeamId ?? null}
                onSaveTeam={onSaveTeam}
                onUpdateTeam={onUpdateTeam}
                onDeleteTeam={onDeleteTeam}
              />
            ) : onChangeSaveRoster ? (
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
          {onChangeUseWorktrees ? (
            <label
              className={`flex items-start gap-2.5 border-t border-[color:var(--border-default)] px-3.5 py-3 text-[12px] text-[color:var(--text-default)] transition-colors ${worktreesDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[color:var(--bg-hover)]'}`}
            >
              <input
                type="checkbox"
                checked={useWorktrees ?? false}
                disabled={worktreesDisabled}
                onChange={(event) => onChangeUseWorktrees(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[color:var(--accent-primary)]"
              />
              <span>
                <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Run in an isolated git worktree</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                  {worktreesDisabled
                    ? 'Worktree mode is fixed for an existing team and cannot be changed here.'
                    : 'All agents work in one shared worktree on a dedicated branch and commit per task; a pull request opens when the run completes.'}
                </span>
              </span>
            </label>
          ) : null}
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

const CUSTOM_TEAM_VALUE = '__custom__'

// Picker that loads a saved roster team into the wizard. Sits above the role
// table so choosing a team rewrites the rows below it. The "Custom roster"
// entry represents an unsaved, hand-tuned config.
function RosterTeamPicker({
  teams,
  selectedTeamId,
  onSelectTeam,
}: {
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  onSelectTeam: (id: string | null) => void
}) {
  const items = [
    { value: CUSTOM_TEAM_VALUE, label: 'Custom roster' },
    ...teams.map((team) => ({ value: team.id, label: team.name })),
  ]
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">Team</span>
      <Select
        ariaLabel="Roster team"
        items={items}
        value={selectedTeamId ?? CUSTOM_TEAM_VALUE}
        onChange={(value) => onSelectTeam(value === CUSTOM_TEAM_VALUE ? null : value)}
        placeholder={teams.length ? 'Pick a team…' : 'No saved teams yet'}
      />
    </div>
  )
}

// Footer affordance for saving the current roster as a named team. When a team
// is already selected it also offers to update or delete it, so the picker
// above stays the single source for switching between saved teams.
function SaveRosterTeamRow({
  teams,
  selectedTeamId,
  onSaveTeam,
  onUpdateTeam,
  onDeleteTeam,
}: {
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  onSaveTeam: (name: string) => void
  onUpdateTeam?: (id: string, name: string) => void
  onDeleteTeam?: (id: string) => void
}) {
  const [adding, setAdding] = React.useState(false)
  const [name, setName] = React.useState('')
  const selectedTeam = selectedTeamId ? teams.find((team) => team.id === selectedTeamId) ?? null : null

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSaveTeam(trimmed)
    setName('')
    setAdding(false)
  }

  if (adding) {
    return (
      <div className="flex items-center gap-2 border-l-2 border-transparent px-3 py-2.5">
        <input
          autoFocus
          type="text"
          value={name}
          placeholder="Team name (e.g. Lightweight)"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setAdding(false)
              setName('')
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-[12px] text-[color:var(--text-default)] outline-none focus:border-[color:var(--accent-primary)]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!name.trim()}
          className="h-7 shrink-0 rounded-[5px] bg-[color:var(--accent-primary)] px-2.5 text-[12px] font-semibold text-[color:var(--bg-app)] transition-colors hover:bg-[color:var(--accent-primary-hover)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(false)
            setName('')
          }}
          className="h-7 shrink-0 rounded-[5px] px-2 text-[12px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-transparent px-3 py-2.5 text-[12px]">
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="text-[color:var(--accent-primary)] transition-colors hover:text-[color:var(--accent-primary-hover)]"
      >
        Save as new team…
      </button>
      {selectedTeam && onUpdateTeam ? (
        <button
          type="button"
          onClick={() => onUpdateTeam(selectedTeam.id, selectedTeam.name)}
          className="text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
        >
          Update “{selectedTeam.name}”
        </button>
      ) : null}
      {selectedTeam && onDeleteTeam ? (
        <button
          type="button"
          onClick={() => onDeleteTeam(selectedTeam.id)}
          className="text-[color:var(--tone-error)] transition-colors hover:opacity-80"
        >
          Delete
        </button>
      ) : null}
    </div>
  )
}
