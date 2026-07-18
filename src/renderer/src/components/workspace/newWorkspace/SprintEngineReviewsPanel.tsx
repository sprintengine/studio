// The sprint wizard's Reviews step (MC-1646, mockup §2): everything about
// checking work on one screen, nothing else sharing it. Self-review is a fixed
// part of every run — each agent reviews its own diff on its own model before
// finishing — so it reads as a plain statement with a hover tooltip, not a
// toggle. Final sweeps are full-width toggle rows with complete, untruncated
// descriptions. The run always keeps the engine defaults for self-review
// (defaultPhases: ['review'], no phaseRuntimes); only requiredSweeps varies.

import React from 'react'

import { CliModelPickerButton, Switch, Tooltip } from '../../ui'
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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-[color:var(--text-strong)]">
              Reviewed by the same agent
            </span>
            <Tooltip
              placement="top"
              className="max-w-[260px] whitespace-normal"
              content="Before it finishes a task, each agent looks back over the diff it just wrote and fixes any problems it finds — in the same session, on the same model. Nothing is handed to a separate reviewer."
            >
              <button
                type="button"
                aria-label="What reviewing by the same agent means"
                className="interactive inline-flex h-4 w-4 items-center justify-center rounded-full text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
              >
                <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
                  <path d="M8 7.4v3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                  <circle cx="8" cy="5.3" r="0.85" fill="currentColor" />
                </svg>
              </button>
            </Tooltip>
          </div>
          <div className="mt-0.5 text-[12px] leading-4 text-[color:var(--text-subtle)]">
            Each agent looks over the work it just made before finishing.
          </div>
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
