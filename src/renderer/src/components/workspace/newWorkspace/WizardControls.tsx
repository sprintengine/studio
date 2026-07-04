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
import { Field, RoleAvatar, Select } from '../../ui'
import { SprintEngineRosterTable, type SprintEngineCliOption } from './SprintEngineRosterTable'
import { sprintEngineTeamNameTaken } from './savedTeams'

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
          <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Agent permissions</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
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
  totalAgents,
  rosterCountLabel,
  teams,
  selectedTeamId,
  selectedTeamDirty,
  onSelectTeam,
  onSaveTeam,
  onUpdateTeam,
  onRenameTeam,
  onDeleteTeam,
  automationMode,
  onChangeAutomationMode,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
  useWorktrees,
  onChangeUseWorktrees,
  worktreesDisabled,
  maxParallelAgents,
  onChangeMaxParallelAgents,
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
  // (Guided Brief handoff) stay as-is.
  roleModelOverrides?: SprintEngineRoleModelOverrides
  onSetModel?: (role: SprintEngineRoleId, model: string | null) => void
  totalAgents: number
  // Lets the Sprint Engine step show "Loading roles" while the registry resolves;
  // omit to show the plain specialist count.
  rosterCountLabel?: string
  // Named roster teams. When `onSelectTeam`/`onSaveTeam` are provided, a team
  // picker is shown above the roster and a "save as team" affordance hangs off
  // the bottom. Omitted by the Guided Brief handoff, which has no roster preset.
  teams?: SprintEngineRosterTeam[]
  selectedTeamId?: string | null
  // True when the current rows have diverged from the selected team, so the
  // picker reads "edited" and Update is offered instead of claiming a clean load.
  selectedTeamDirty?: boolean
  onSelectTeam?: (id: string | null) => void
  onSaveTeam?: (name: string) => void
  onUpdateTeam?: (id: string, name: string) => void
  onRenameTeam?: (id: string, name: string) => void
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
  // Workspace-level cap on concurrent agent sessions (MC-1450: replaces the
  // retired per-role count ceiling). Omitted by surfaces without run options.
  maxParallelAgents?: number
  onChangeMaxParallelAgents?: (value: number) => void
}) {
  // The saved-teams rail (two-column layout) is available only where team
  // management is wired up — the Sprint Engine wizard. The Guided Brief handoff
  // omits the team props, so it keeps the single-column roster automatically.
  const showTeamRail = Boolean(onSelectTeam && onSaveTeam) && !countDisabled
  const rosterCount = (
    <span className="text-[11px] tabular-nums text-[color:var(--text-muted)]">
      {rosterCountLabel ?? `${totalAgents} specialist${totalAgents === 1 ? '' : 's'}`}
    </span>
  )
  const rosterTable = (
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
      footer={
        // In rail mode the save/update/rename/delete affordances live in the
        // rail footer; only the single-column layout hangs them off the table.
        !showTeamRail && onSaveTeam ? (
          <SaveRosterTeamRow
            teams={teams ?? []}
            selectedTeamId={selectedTeamId ?? null}
            selectedTeamDirty={selectedTeamDirty ?? false}
            onSaveTeam={onSaveTeam}
            onUpdateTeam={onUpdateTeam}
            onRenameTeam={onRenameTeam}
            onDeleteTeam={onDeleteTeam}
          />
        ) : undefined
      }
    />
  )
  return (
    <>
      <div className="flex flex-col gap-2">
        {showTeamRail ? (
          <div className="grid grid-cols-[236px_minmax(0,1fr)] items-start gap-4">
            <RosterTeamsRail
              roleCounts={roleCounts}
              registry={registry}
              teams={teams ?? []}
              selectedTeamId={selectedTeamId ?? null}
              selectedTeamDirty={selectedTeamDirty ?? false}
              onSelectTeam={onSelectTeam!}
              onSaveTeam={onSaveTeam!}
              onUpdateTeam={onUpdateTeam}
              onRenameTeam={onRenameTeam}
              onDeleteTeam={onDeleteTeam}
            />
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Field.Label>Roster</Field.Label>
                {rosterCount}
              </div>
              {rosterTable}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <Field.Label>Roster</Field.Label>
              {rosterCount}
            </div>
            {onSelectTeam && !countDisabled && (teams?.length ?? 0) > 0 ? (
              <RosterTeamPicker
                teams={teams ?? []}
                selectedTeamId={selectedTeamId ?? null}
                selectedTeamDirty={selectedTeamDirty ?? false}
                onSelectTeam={onSelectTeam}
              />
            ) : null}
            {rosterTable}
          </>
        )}
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
                How the sprint should continue after this workspace opens.
              </span>
            </div>
            <div className="grid gap-2" role="radiogroup" aria-label="Sprint automation mode">
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
          {onChangeMaxParallelAgents ? (
            <div className="flex items-start justify-between gap-3 border-t border-[color:var(--border-default)] px-3.5 py-3">
              <label htmlFor="sprintengine-max-parallel-agents" className="min-w-0">
                <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Max parallel agents</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                  Cap on agent sessions running at once, across all roles. Extra ready tasks queue until a slot frees up.
                </span>
              </label>
              <input
                id="sprintengine-max-parallel-agents"
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                step={1}
                value={maxParallelAgents ?? 3}
                onChange={(event) => {
                  const parsed = Math.floor(Number(event.target.value))
                  if (Number.isFinite(parsed)) {
                    onChangeMaxParallelAgents(Math.max(1, Math.min(10, parsed)))
                  }
                }}
                className="
                  h-7 w-16 shrink-0 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)]
                  px-2 text-right text-[12px] tabular-nums text-[color:var(--text-strong)]
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                "
              />
            </div>
          ) : null}
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

function railTeamMembers(roleCounts: SprintEngineRoleCounts): SprintEngineRoleId[] {
  return Object.keys(roleCounts).filter((role) => (roleCounts[role] ?? 0) > 0)
}
function railTeamTotal(roleCounts: SprintEngineRoleCounts): number {
  return Object.values(roleCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0)
}

// Browsable left rail of saved teams (replaces the compact "Team" dropdown).
// The "Custom roster" entry is the current, unsaved config; each saved team is a
// card that loads on click. Save / update / rename / delete hang off the footer,
// reusing SaveRosterTeamRow so the two surfaces cannot drift.
function RosterTeamsRail({
  roleCounts,
  registry,
  teams,
  selectedTeamId,
  selectedTeamDirty,
  onSelectTeam,
  onSaveTeam,
  onUpdateTeam,
  onRenameTeam,
  onDeleteTeam,
}: {
  roleCounts: SprintEngineRoleCounts
  registry?: SprintEngineRoleRegistry | null
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  selectedTeamDirty: boolean
  onSelectTeam: (id: string | null) => void
  onSaveTeam: (name: string) => void
  onUpdateTeam?: (id: string, name: string) => void
  onRenameTeam?: (id: string, name: string) => void
  onDeleteTeam?: (id: string) => void
}) {
  return (
    <aside className="flex flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2.5">
        <Field.Label>Teams</Field.Label>
        <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">{teams.length}</span>
      </div>
      <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
        <RailTeamCard
          name="Custom roster"
          roleCounts={roleCounts}
          registry={registry}
          active={!selectedTeamId}
          edited={false}
          onSelect={() => onSelectTeam(null)}
        />
        {teams.map((team) => (
          <RailTeamCard
            key={team.id}
            name={team.name}
            roleCounts={team.roleCounts}
            registry={registry}
            active={selectedTeamId === team.id}
            edited={selectedTeamId === team.id && selectedTeamDirty}
            onSelect={() => onSelectTeam(team.id)}
          />
        ))}
      </div>
      <div className="border-t border-[color:var(--border-default)]">
        <SaveRosterTeamRow
          teams={teams}
          selectedTeamId={selectedTeamId}
          selectedTeamDirty={selectedTeamDirty}
          onSaveTeam={onSaveTeam}
          onUpdateTeam={onUpdateTeam}
          onRenameTeam={onRenameTeam}
          onDeleteTeam={onDeleteTeam}
        />
      </div>
    </aside>
  )
}

function RailTeamCard({
  name,
  roleCounts,
  registry,
  active,
  edited,
  onSelect,
}: {
  name: string
  roleCounts: SprintEngineRoleCounts
  registry?: SprintEngineRoleRegistry | null
  active: boolean
  edited: boolean
  onSelect: () => void
}) {
  const members = railTeamMembers(roleCounts)
  const total = railTeamTotal(roleCounts)
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`relative flex flex-col gap-1.5 rounded-[6px] border px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)] ${
        active
          ? 'border-[color:var(--accent-primary-soft)] bg-[color:var(--accent-primary-soft)]'
          : 'border-transparent hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      {active ? (
        <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-[color:var(--accent-primary)]" />
      ) : null}
      <span className="flex items-center gap-1.5">
        <span className={`min-w-0 flex-1 truncate text-[12px] font-medium ${active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
          {name}
        </span>
        {edited ? <span className="shrink-0 text-[10px] font-semibold text-[color:var(--accent-primary)]">· edited</span> : null}
      </span>
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1">
          {members.slice(0, 5).map((role) => (
            <RoleAvatar key={role} role={role} registry={registry} size="xs" ariaLabel="" />
          ))}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-[color:var(--text-muted)]">{total || '—'}</span>
      </span>
    </button>
  )
}

const CUSTOM_TEAM_VALUE = '__custom__'

// Picker that loads a saved roster team into the wizard. Sits above the role
// table so choosing a team rewrites the rows below it. The "Custom roster"
// entry represents an unsaved, hand-tuned config.
function RosterTeamPicker({
  teams,
  selectedTeamId,
  selectedTeamDirty,
  onSelectTeam,
}: {
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  selectedTeamDirty: boolean
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
      {selectedTeamId && selectedTeamDirty ? (
        // Truthful state: the rows no longer match the named team. Without this
        // the picker keeps claiming a clean team while the roster has diverged.
        <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">· edited</span>
      ) : null}
    </div>
  )
}

// Footer affordance for saving the current roster as a named team. When a team
// is selected it also offers to update (re-save the edited roster), rename, or
// delete it, so the picker above stays the single source for switching teams.
function SaveRosterTeamRow({
  teams,
  selectedTeamId,
  selectedTeamDirty,
  onSaveTeam,
  onUpdateTeam,
  onRenameTeam,
  onDeleteTeam,
}: {
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  selectedTeamDirty: boolean
  onSaveTeam: (name: string) => void
  onUpdateTeam?: (id: string, name: string) => void
  onRenameTeam?: (id: string, name: string) => void
  onDeleteTeam?: (id: string) => void
}) {
  // 'idle' | 'adding' (new team) | 'renaming' (selected team).
  const [editing, setEditing] = React.useState<'idle' | 'adding' | 'renaming'>('idle')
  const [name, setName] = React.useState('')
  const selectedTeam = selectedTeamId ? teams.find((team) => team.id === selectedTeamId) ?? null : null

  const close = () => {
    setEditing('idle')
    setName('')
  }
  const beginRename = () => {
    if (!selectedTeam) return
    setName(selectedTeam.name)
    setEditing('renaming')
  }

  if (editing !== 'idle') {
    const trimmed = name.trim()
    const excludeId = editing === 'renaming' ? selectedTeam?.id ?? null : null
    const collides = sprintEngineTeamNameTaken(teams, trimmed, excludeId)
    const canSubmit = trimmed.length > 0 && !collides
    const submit = () => {
      if (!canSubmit) return
      if (editing === 'renaming' && selectedTeam && onRenameTeam) {
        onRenameTeam(selectedTeam.id, trimmed)
      } else {
        onSaveTeam(trimmed)
      }
      close()
    }
    return (
      <div className="flex flex-col gap-1 border-l-2 border-transparent px-3 py-2.5">
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={name}
            placeholder={editing === 'renaming' ? 'Team name' : 'Team name (e.g. Lightweight)'}
            aria-label={editing === 'renaming' ? 'Rename team' : 'New team name'}
            aria-invalid={collides}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
            className={`h-7 min-w-0 flex-1 rounded-[5px] border bg-[color:var(--bg-surface-raised)] px-2 text-[12px] text-[color:var(--text-default)] outline-none ${
              collides
                ? 'border-[color:var(--tone-error)]'
                : 'border-[color:var(--border-default)] focus:border-[color:var(--accent-primary)]'
            }`}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="h-7 shrink-0 rounded-[5px] bg-[color:var(--accent-primary)] px-2.5 text-[12px] font-semibold text-[color:var(--bg-app)] transition-colors hover:bg-[color:var(--accent-primary-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {editing === 'renaming' ? 'Rename' : 'Save'}
          </button>
          <button
            type="button"
            onClick={close}
            className="h-7 shrink-0 rounded-[5px] px-2 text-[12px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
          >
            Cancel
          </button>
        </div>
        {collides ? (
          <span className="text-[11px] text-[color:var(--tone-error)]">A team named “{trimmed}” already exists.</span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-transparent px-3 py-2.5 text-[12px]">
      <button
        type="button"
        onClick={() => setEditing('adding')}
        className="text-[color:var(--accent-primary)] transition-colors hover:text-[color:var(--accent-primary-hover)]"
      >
        Save as new team…
      </button>
      {selectedTeam && selectedTeamDirty && onUpdateTeam ? (
        <button
          type="button"
          onClick={() => onUpdateTeam(selectedTeam.id, selectedTeam.name)}
          className="text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
        >
          Update “{selectedTeam.name}”
        </button>
      ) : null}
      {selectedTeam && onRenameTeam ? (
        <button
          type="button"
          onClick={beginRename}
          className="text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
        >
          Rename
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
