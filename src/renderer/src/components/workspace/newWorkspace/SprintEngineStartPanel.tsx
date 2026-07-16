// The sprint wizard's Review & start step (MC-1646, mockup §4): everything
// chosen so far as one glanceable summary with Edit links back to each page,
// and the run settings — permissions, automation, parallelism, worktree —
// demoted to quiet inline controls. One primary action per screen (the
// footer's Start sprint); this page adds no second one.

import React from 'react'

import type {
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import type { StepId } from './creationStepFlows'
import type { SprintEngineCliOption } from './SprintEngineRosterTable'
import type { SprintEngineReviewRuntime } from './sprintengineWorkflowConfig'
import type { SprintEngineTeamMode } from './SprintEngineTeamPanel'
import { sprintEngineAutomationModeOptions } from '../../../utils/sprintengineAutomation'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import { listSprintEngineWizardWorkRoles } from '../../../utils/sprintengineRoleOptions'
import { RoleAvatar, Select, Switch } from '../../ui'
import { AlsoChangesProjectsPanel, cliPermissionOptions, type WizardSiblingProject } from './WizardControls'

// Human-readable "CLI · model" label for a role, mirroring the picker chips.
function runtimeLabelFor(
  cli: string | undefined,
  model: string | null | undefined,
  cliOptions: SprintEngineCliOption[],
): string | null {
  if (!cli) return null
  const option = cliOptions.find((candidate) => candidate.value === cli)
  const cliLabel = option?.label ?? cli
  if (!model) return cliLabel
  const modelLabel = option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
  return `${cliLabel} · ${modelLabel}`
}

export function SprintEngineStartPanel({
  workspaceName,
  folderPath,
  objective,
  teamMode,
  hasExistingTeam,
  existingTeamName,
  roleCounts,
  registry,
  disabledRoleIds,
  cliOptions,
  roleCliDefaults,
  roleModelOverrides,
  poolAgentCount,
  architectSeatLabel,
  showReviewsRow,
  selfReviewEnabled,
  reviewRuntime,
  requiredSweepRoleIds,
  selectedToolNames,
  selectedSkillPackCount,
  onEditStep,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
  automationMode,
  onChangeAutomationMode,
  maxParallelAgents,
  onChangeMaxParallelAgents,
  showMaxParallelAgents,
  useWorktrees,
  onChangeUseWorktrees,
  worktreesDisabled,
  projectOptions,
  selectedProjectIds,
  onToggleProject,
  projectsDisabled,
  createError,
}: {
  workspaceName: string
  folderPath: string | null
  objective: string
  teamMode: SprintEngineTeamMode
  hasExistingTeam: boolean
  existingTeamName: string | null
  roleCounts: SprintEngineRoleCounts
  registry: SprintEngineRoleRegistry | null
  disabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
  cliOptions: SprintEngineCliOption[]
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
  poolAgentCount: number
  architectSeatLabel: string | null
  /** False for an existing team (its review workflow is already initialized). */
  showReviewsRow: boolean
  selfReviewEnabled: boolean
  reviewRuntime: SprintEngineReviewRuntime | null
  requiredSweepRoleIds: ReadonlySet<SprintEngineRoleId>
  selectedToolNames: string[]
  selectedSkillPackCount: number
  onEditStep: (step: StepId) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  maxParallelAgents: number
  onChangeMaxParallelAgents: (value: number) => void
  /** Hidden in pool mode — the Team step's stepper owns the same value. */
  showMaxParallelAgents: boolean
  useWorktrees: boolean
  onChangeUseWorktrees: (value: boolean) => void
  worktreesDisabled: boolean
  // "Also changes these projects" (MC-1613): the sibling projects on disk this
  // run may also change, none selected by default. Shown only in worktree mode,
  // and only when the workspace has a sibling project to offer.
  projectOptions: readonly WizardSiblingProject[]
  selectedProjectIds: readonly string[]
  onToggleProject: (id: string, on: boolean) => void
  projectsDisabled: boolean
  createError: string | null
}) {
  const onRoles = listSprintEngineWizardWorkRoles(registry, disabledRoleIds).filter(
    (role) => (roleCounts[role] ?? 0) > 0,
  )

  // Team line: who builds, and on what runtime when that reads in one crumb.
  const runtimeLabels = new Set(
    onRoles.map((role) => runtimeLabelFor(roleCliDefaults[role], roleModelOverrides[role], cliOptions) ?? ''),
  )
  const sharedRuntime = runtimeLabels.size === 1 ? [...runtimeLabels][0] : null
  const teamSummary = hasExistingTeam
    ? { text: existingTeamName ?? 'Existing team', crumb: 'loads with its saved roster' }
    : teamMode === 'pool'
      ? {
          text: `Agent pool · ${poolAgentCount} agent${poolAgentCount === 1 ? '' : 's'}`,
          crumb: runtimeLabelFor(
            roleCliDefaults.general,
            roleModelOverrides.general,
            cliOptions,
          ) ?? undefined,
        }
      : teamMode === 'architect'
        ? { text: 'Architect picks the team', crumb: architectSeatLabel ?? undefined }
        : {
            text: `${onRoles.length} role${onRoles.length === 1 ? '' : 's'}, picked yourself`,
            crumb: sharedRuntime ?? 'mixed runtimes',
          }

  const sweepLabels = [...requiredSweepRoleIds].map((role) => getSprintEngineRoleLabel(role, registry))
  const reviewsSummary = [
    selfReviewEnabled
      ? reviewRuntime
        ? 'Self-review by a stronger model'
        : 'Self-review by the same agent'
      : 'No self-review',
    sweepLabels.length > 0 ? `${sweepLabels.join(', ')} sweep${sweepLabels.length === 1 ? '' : 's'}` : 'no final sweeps',
  ].join(' · ')

  const toolsSummary =
    selectedToolNames.length === 0 && selectedSkillPackCount === 0
      ? 'None — the sprint runs without integrations'
      : [
          selectedToolNames.length > 0 ? selectedToolNames.join(', ') : null,
          selectedSkillPackCount > 0
            ? `${selectedSkillPackCount} skill pack${selectedSkillPackCount === 1 ? '' : 's'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')

  const permissionOption =
    cliPermissionOptions.find((option) => option.value === cliPermissionPreset) ?? cliPermissionOptions[0]
  const automationOption =
    sprintEngineAutomationModeOptions.find((option) => option.value === automationMode)
    ?? sprintEngineAutomationModeOptions[0]

  return (
    <div className="flex flex-col">
      {createError ? (
        <div className="mb-4 border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {createError}
        </div>
      ) : null}

      <div className="border-t border-[color:var(--border-subtle)]">
        <SummaryRow label="Workspace" onEdit={() => onEditStep('workspace')}>
          <span className="font-medium text-[color:var(--text-strong)]">{workspaceName || 'workspace'}</span>
          {folderPath ? (
            <span className="font-mono text-[11px] text-[color:var(--text-subtle)]"> · {folderPath}</span>
          ) : null}
        </SummaryRow>
        <SummaryRow label="Objective" onEdit={() => onEditStep('sprintengine-team')}>
          {objective || <span className="text-[color:var(--text-subtle)]">No objective set</span>}
        </SummaryRow>
        <SummaryRow label="Team" onEdit={() => onEditStep('sprintengine-roster')}>
          <span className="flex items-center gap-2">
            {(!hasExistingTeam && teamMode === 'roles') || hasExistingTeam ? (
              <span className="flex pl-1" aria-hidden="true">
                {onRoles.map((role) => (
                  <span key={role} className="-ml-1 inline-flex rounded-full ring-2 ring-[color:var(--bg-app)]">
                    <RoleAvatar role={role} registry={registry} size="xs" ariaLabel="" />
                  </span>
                ))}
              </span>
            ) : null}
            <span className="min-w-0">
              {teamSummary.text}
              {teamSummary.crumb ? (
                <span className="text-[color:var(--text-subtle)]"> · {teamSummary.crumb}</span>
              ) : null}
            </span>
          </span>
        </SummaryRow>
        {showReviewsRow ? (
          <SummaryRow label="Reviews" onEdit={() => onEditStep('sprintengine-reviews')}>
            {reviewsSummary}
          </SummaryRow>
        ) : null}
        <SummaryRow label="Tools" onEdit={() => onEditStep('sprintengine-tools')}>
          {toolsSummary}
        </SummaryRow>
      </div>

      <p className="mb-1 mt-6 text-[12px] font-semibold text-[color:var(--text-strong)]">Run settings</p>
      <div className="flex flex-col">
        <RunRow label="Permissions">
          <Select<SprintEngineCliPermissionPreset>
            ariaLabel="Agent permission preset"
            items={cliPermissionOptions.map((option) => ({
              value: option.value,
              label: option.label,
              tone: option.value === 'bypass_all' ? ('warn' as const) : undefined,
            }))}
            value={cliPermissionPreset}
            onChange={onChangeCliPermissionPreset}
          />
          <div
            className={`mt-1.5 text-[11px] leading-4 ${
              cliPermissionPreset === 'bypass_all'
                ? 'text-[color:var(--tone-warn)]'
                : 'text-[color:var(--text-subtle)]'
            }`}
          >
            {permissionOption.hint}
          </div>
        </RunRow>
        <RunRow label="Automation">
          <Select<SprintEngineAutomationMode>
            ariaLabel="Sprint automation mode"
            items={sprintEngineAutomationModeOptions.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            value={automationMode}
            onChange={onChangeAutomationMode}
          />
          <div className="mt-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">{automationOption.hint}</div>
        </RunRow>
        {showMaxParallelAgents ? (
          <RunRow label="Parallel agents">
            <input
              id="sprintengine-max-parallel-agents"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              step={1}
              value={maxParallelAgents}
              aria-label="Max parallel agents"
              onChange={(event) => {
                const parsed = Math.floor(Number(event.target.value))
                if (Number.isFinite(parsed)) {
                  onChangeMaxParallelAgents(Math.max(1, Math.min(10, parsed)))
                }
              }}
              className="
                h-7 w-16 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)]
                px-2 text-right text-[12px] tabular-nums text-[color:var(--text-strong)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            />
            <div className="mt-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
              Cap on agent sessions running at once. Extra ready tasks queue until a slot frees up.
            </div>
          </RunRow>
        ) : null}
        <RunRow label="Worktree">
          <span className="flex items-center gap-2.5">
            <Switch
              ariaLabel="Run in an isolated git worktree"
              checked={useWorktrees}
              disabled={worktreesDisabled}
              onChange={onChangeUseWorktrees}
            />
            <span className="text-[12px] text-[color:var(--text-default)]">Run in an isolated git worktree</span>
          </span>
          <div className="mt-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
            {worktreesDisabled
              ? 'Worktree mode is fixed for an existing team and cannot be changed here.'
              : 'All agents work in one shared worktree on a dedicated branch; a pull request opens when the run completes.'}
          </div>
        </RunRow>
        <AlsoChangesProjectsPanel
          projects={projectOptions}
          selectedProjectIds={selectedProjectIds}
          onToggleProject={onToggleProject}
          disabled={projectsDisabled}
          useWorktrees={useWorktrees}
        />
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  onEdit,
  children,
}: {
  label: string
  onEdit: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3.5 border-b border-[color:var(--border-subtle)] py-3">
      <span className="w-24 shrink-0 text-[11px] text-[color:var(--text-subtle)]">{label}</span>
      <span className="min-w-0 flex-1 text-[12px] leading-5 text-[color:var(--text-default)]">{children}</span>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${label.toLowerCase()}`}
        className="shrink-0 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--accent-primary)]"
      >
        Edit
      </button>
    </div>
  )
}

function RunRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3.5 border-b border-[color:var(--border-subtle)] py-2.5">
      <span className="w-24 shrink-0 pt-1 text-[11px] text-[color:var(--text-subtle)]">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
