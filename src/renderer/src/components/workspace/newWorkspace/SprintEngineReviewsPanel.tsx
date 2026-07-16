// The sprint wizard's Reviews step (MC-1646, mockup §2): everything about
// checking work on one screen, nothing else sharing it. Self-review is a
// switch whose "reviewed by" choice renders only while it is on; final sweeps
// are full-width toggle rows with complete, untruncated descriptions. Absorbs
// the old SprintEngineWorkflowPanels ("Workflow steps" + "Final sweeps") — the
// state contract (defaultPhases / phaseRuntimes / requiredSweeps via
// sprintengineWorkflowConfig) is unchanged.

import React from 'react'

import { CliModelPickerButton, SegmentedControl, Switch } from '../../ui'
import { getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import {
  getSprintEngineWizardRoleSummary,
  listSprintEngineWizardSweepRoles,
} from '../../../utils/sprintengineRoleOptions'
import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleRegistry,
} from '../../../types/workspace'
import type { SprintEngineReviewRuntime } from './sprintengineWorkflowConfig'
import type { SprintEngineCliOption } from './SprintEngineRosterTable'

// Effective launch model for a role/runtime override: explicit override
// (string), otherwise the CLI default (undefined -> no model flag).
function effectiveRoleModel(
  role: SprintEngineRoleId,
  roleModelOverrides: SprintEngineRoleModelOverrides | undefined,
): string | undefined {
  const override = roleModelOverrides?.[role]
  if (override === null) return undefined
  return override || undefined
}

export function SprintEngineReviewsPanel({
  cliOptions,
  registry,
  disabledRoleIds,
  selfReviewEnabled,
  onChangeSelfReviewEnabled,
  reviewRuntime,
  onChangeReviewRuntime,
  requiredSweepRoleIds,
  onToggleRequiredSweep,
  roleCliDefaults,
  roleModelOverrides,
  onSetRoleCli,
  onSetRoleModel,
  showFinalSweeps = true,
}: {
  cliOptions: SprintEngineCliOption[]
  registry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
  // "Agents review their own work" switch -> defaultPhases.
  selfReviewEnabled: boolean
  onChangeSelfReviewEnabled: (value: boolean) => void
  // Reviewer runtime: null = "the same agent that wrote it"; a value binds a
  // stronger model -> phaseRuntimes.review.
  reviewRuntime: SprintEngineReviewRuntime | null
  onChangeReviewRuntime: (runtime: SprintEngineReviewRuntime | null) => void
  // Operator-mandated sweeps -> requiredSweeps. Each sweep's model binding
  // reuses the roster's roleRuntimes state (roleCliDefaults/roleModelOverrides).
  requiredSweepRoleIds: ReadonlySet<SprintEngineRoleId>
  onToggleRequiredSweep: (role: SprintEngineRoleId, next: boolean) => void
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetRoleModel: (role: SprintEngineRoleId, model: string | null) => void
  // Final sweeps are a specialist affordance (MC-1585): hidden while the run
  // is a plain agent pool. Self-review stays — a plain agent still reviews its
  // own work.
  showFinalSweeps?: boolean
}) {
  const sweepRoles = showFinalSweeps ? listSprintEngineWizardSweepRoles(registry, disabledRoleIds) : []
  const fallbackCli = cliOptions[0]?.value ?? 'claude-code'

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-[color:var(--border-subtle)] py-3">
        <span className="mt-0.5">
          <Switch
            ariaLabel="Agents review their own work"
            checked={selfReviewEnabled}
            onChange={onChangeSelfReviewEnabled}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`text-[13px] ${
              selfReviewEnabled
                ? 'font-medium text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-muted)]'
            }`}
          >
            Agents review their own work
          </div>
          <div className="mt-0.5 text-[12px] leading-4 text-[color:var(--text-subtle)]">
            Each agent looks over the work it just made before finishing.
          </div>
          {selfReviewEnabled ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <span className="text-[11px] font-semibold text-[color:var(--text-subtle)]">Reviewed by</span>
              <SegmentedControl<'same' | 'stronger'>
                ariaLabel="Who reviews the work"
                items={[
                  { value: 'same', label: 'Same agent' },
                  { value: 'stronger', label: 'Stronger model' },
                ]}
                value={reviewRuntime === null ? 'same' : 'stronger'}
                onChange={(choice) => {
                  if (choice === 'same') onChangeReviewRuntime(null)
                  else if (reviewRuntime === null) onChangeReviewRuntime({ cli: fallbackCli, model: null })
                }}
              />
              {reviewRuntime !== null ? (
                <CliModelPickerButton
                  ariaLabel="Reviewer agent runtime"
                  options={cliOptions}
                  maxWidthClassName="max-w-none"
                  cli={reviewRuntime.cli as AgentCli}
                  effectiveModelFor={(candidateCli) =>
                    candidateCli === reviewRuntime.cli ? reviewRuntime.model ?? undefined : undefined
                  }
                  onSelectCli={(nextCli) => onChangeReviewRuntime({ cli: nextCli, model: null })}
                  onSelectModel={(nextCli, nextModel) => onChangeReviewRuntime({ cli: nextCli, model: nextModel })}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {sweepRoles.length > 0 ? (
        <>
          <p className="mb-0.5 mt-6 text-[12px] font-semibold text-[color:var(--text-strong)]">Final sweeps</p>
          <p className="mb-1 text-[12px] leading-4 text-[color:var(--text-subtle)]">
            Specialist reviews of the finished work at the end of the run. Only the sweeps you turn on join the team.
          </p>
          {sweepRoles.map((role) => {
            const isOn = requiredSweepRoleIds.has(role)
            const label = getSprintEngineRoleLabel(role, registry)
            const summary = getSprintEngineWizardRoleSummary(role, registry)
            const roleCli = roleCliDefaults[role] ?? fallbackCli
            return (
              <div key={role} className="flex items-start gap-3 border-b border-[color:var(--border-subtle)] py-3">
                <span className="mt-0.5">
                  <Switch
                    ariaLabel={`${label} sweep`}
                    checked={isOn}
                    onChange={(next) => onToggleRequiredSweep(role, next)}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-[13px] ${
                      isOn ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
                    }`}
                  >
                    {label}
                  </div>
                  <div className="mt-0.5 text-[12px] leading-4 text-[color:var(--text-subtle)]">{summary}</div>
                </div>
                {isOn ? (
                  <CliModelPickerButton
                    ariaLabel={`${label} agent runtime`}
                    options={cliOptions}
                    maxWidthClassName="max-w-none"
                    cli={roleCli}
                    effectiveModelFor={(candidateCli) =>
                      candidateCli === roleCli ? effectiveRoleModel(role, roleModelOverrides) : undefined
                    }
                    onSelectCli={(nextCli) => onSetRoleCli(role, nextCli)}
                    onSelectModel={(nextCli, nextModel) => {
                      if (nextCli !== roleCli) onSetRoleCli(role, nextCli)
                      onSetRoleModel(role, nextModel)
                    }}
                  />
                ) : null}
              </div>
            )
          })}
        </>
      ) : null}
    </div>
  )
}
