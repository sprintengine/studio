import React from 'react'

import { CliModelPickerButton, Field, RoleAvatar } from '../../ui'
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

// Plain-copy label overrides for a sweep row's headline. QA reads as an action
// ("QA tests the finished work") rather than a role name, per the spec.
const SWEEP_ROLE_HEADLINE: Partial<Record<SprintEngineRoleId, string>> = {
  tester: 'QA tests the finished work',
}

// Effective launch model for a role/runtime override: explicit override
// (string), otherwise the CLI default (undefined -> no model flag). Mirrors the
// roster table's `effectiveRoleModel`.
function effectiveRoleModel(
  role: SprintEngineRoleId,
  roleModelOverrides: SprintEngineRoleModelOverrides | undefined,
): string | undefined {
  const override = roleModelOverrides?.[role]
  if (override === null) return undefined
  if (override) return override
  return undefined
}

// The "Workflow steps" and "Final sweeps" panels of the reframed roster step
// (MC-1542 / MC-1543). Plain-human copy only — no "phase"/"sweep"/"runtime"
// jargon in visible text. Every control reuses the wizard's existing primitives
// (CliModelPickerButton, RoleAvatar, the run-settings checkbox pattern) so the
// two panels cannot drift from the rest of the wizard.
export function SprintEngineWorkflowPanels({
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
}: {
  cliOptions: SprintEngineCliOption[]
  registry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
  // "Agents review their own work" toggle -> defaultPhases.
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
}) {
  const sweepRoles = listSprintEngineWizardSweepRoles(registry, disabledRoleIds)
  const fallbackCli = cliOptions[0]?.value ?? 'claude-code'

  return (
    <>
      <div className="flex flex-col gap-2">
        <Field.Label>Workflow steps</Field.Label>
        <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <label className="flex cursor-pointer items-start gap-2.5 px-3.5 py-3 text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)]">
            <input
              type="checkbox"
              checked={selfReviewEnabled}
              onChange={(event) => onChangeSelfReviewEnabled(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[color:var(--accent-primary)]"
            />
            <span>
              <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Agents review their own work</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                Each agent looks over the work it just made before finishing. Turn this off to have agents finish without a review pass.
              </span>
            </span>
          </label>
          {selfReviewEnabled ? (
            <div className="flex flex-col gap-2 border-t border-[color:var(--border-default)] px-3.5 py-3">
              <span className="block text-[12px] font-semibold text-[color:var(--text-strong)]">Who reviews the work?</span>
              <div role="radiogroup" aria-label="Who reviews the work" className="flex flex-col gap-2">
                <ReviewerChoice
                  checked={reviewRuntime === null}
                  label="The same agent that wrote it"
                  onSelect={() => onChangeReviewRuntime(null)}
                />
                <div className="flex flex-col gap-2">
                  <ReviewerChoice
                    checked={reviewRuntime !== null}
                    label="A stronger model"
                    onSelect={() => {
                      if (reviewRuntime === null) onChangeReviewRuntime({ cli: fallbackCli, model: null })
                    }}
                  />
                  {reviewRuntime !== null ? (
                    <div className="pl-6">
                      <CliModelPickerButton
                        ariaLabel="Reviewer agent runtime"
                        options={cliOptions}
                        cli={reviewRuntime.cli as AgentCli}
                        effectiveModelFor={(candidateCli) =>
                          candidateCli === reviewRuntime.cli ? reviewRuntime.model ?? undefined : undefined
                        }
                        onSelectCli={(nextCli) => onChangeReviewRuntime({ cli: nextCli, model: null })}
                        onSelectModel={(nextCli, nextModel) => onChangeReviewRuntime({ cli: nextCli, model: nextModel })}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {sweepRoles.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Field.Label>Final sweeps</Field.Label>
          <p className="text-[11px] leading-4 text-[color:var(--text-muted)]">
            Specialist reviews of the finished work at the end of the run. Only the sweeps you turn on join the team and get scheduled — anything left off stays out of the run.
          </p>
          {/* Designated scroll region: on the hub's fixed-height run page this
              list absorbs the column's leftover space and scrolls internally
              (the floor keeps two rows visible); in auto-height contexts (the
              Guided Brief handoff) flex-1 is a no-op and it renders in full. */}
          <div className="min-h-[104px] flex-1 divide-y divide-[color:var(--border-default)] overflow-y-auto rounded-md border border-[color:var(--border-default)]">
            {sweepRoles.map((role) => {
              const isOn = requiredSweepRoleIds.has(role)
              const label = getSprintEngineRoleLabel(role, registry)
              const headline = SWEEP_ROLE_HEADLINE[role] ?? label
              const summary = getSprintEngineWizardRoleSummary(role, registry)
              const roleCli = roleCliDefaults[role] ?? fallbackCli
              return (
                <div
                  key={role}
                  className={`group relative flex items-stretch gap-2 border-l-2 transition-colors ${
                    isOn
                      ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                      : 'border-transparent hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isOn}
                    aria-label={isOn ? `${headline} — always runs, activate to remove` : `${headline} — add as an always-run review`}
                    onClick={() => onToggleRequiredSweep(role, !isOn)}
                    className="
                      flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)]
                    "
                  >
                    <RoleAvatar role={role} registry={registry} size="md" ariaLabel="" className={isOn ? undefined : 'opacity-55'} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[12px] font-medium ${isOn ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
                        {headline}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-muted)]">{summary}</span>
                    </span>
                    {!isOn ? (
                      <span
                        aria-hidden="true"
                        className="shrink-0 pr-1 text-[11px] font-semibold text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        Always run
                      </span>
                    ) : null}
                  </button>
                  {isOn ? (
                    <div className="flex shrink-0 items-center gap-2 py-2 pr-2">
                      <CliModelPickerButton
                        ariaLabel={`${label} agent runtime`}
                        options={cliOptions}
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
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </>
  )
}

// One reviewer-choice radio row. Mirrors the run-settings radio affordance
// (PathRadio) at a lighter weight for this inline sub-control.
function ReviewerChoice({
  checked,
  label,
  onSelect,
}: {
  checked: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex items-center gap-2.5 text-left text-[12px] transition-colors focus:outline-none"
    >
      <span
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          checked ? 'border-[color:var(--text-strong)] bg-[color:var(--text-strong)]' : 'border-[color:var(--color-6)]'
        }`}
        aria-hidden="true"
      >
        {/* design-tokens-allow: inner glyph of a custom radio control — not a status dot */}
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" /> : null}
      </span>
      <span className={`${checked ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>{label}</span>
    </button>
  )
}
