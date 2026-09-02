// The plain-agents ("No roles") configuration: how many agents share the run
// (bound to the concurrency cap, not a roster count) and which agent + model
// they all run. Moved out of SprintEngineRosterPanel with MC-2064 — "No roles"
// is not a roster, so its controls live on the create surface, the only place
// a plain-agent run is configured. Exactly two rows and no explanatory copy
// (MC-2062): there is nothing to step into, so the card must read at a glance.

import type { AgentCli } from '../../../types/workspace'
import { CliModelPickerButton, OutlineButton, Tooltip } from '../../ui'
import {
  PLANNING_AGENT_NONE_DESCRIPTION,
  PLANNING_AGENT_NONE_LABEL,
  PLANNING_AGENT_ROW_LABEL,
  PLANNING_AGENT_TOOLTIP,
} from '../newSprint/newSprintModel'
import { SprintIsolationRowView, type SprintIsolationRow } from '../newSprint/SprintIsolationRow'
import { SprintConnectorsRowView, type SprintConnectorsRow } from '../newSprint/SprintConnectorsRow'
import { AgentCliSelect, type SprintEngineCliOption } from './SprintEngineRosterTable'

/**
 * The optional third row (MC-2129): which agent plans this sprint before any
 * work starts, or None. Opt-in, because only the create surface knows whether
 * this run HAS an authored plan to fall back on.
 *
 * `allowNone` is the epic/non-epic distinction: with an epic there is an authored
 * order to run in, so None is a real answer; without one something must plan, and
 * the row appears with an agent already picked and no way to clear it. One row in
 * both worlds — never a control that is present here and absent there.
 */
export type PlanningAgentRow = {
  cli: AgentCli
  effectiveModel: string | undefined
  effectiveReasoning?: string | undefined
  /** True when the row's value is None: nothing plans, the epic is the plan. */
  isNone: boolean
  allowNone: boolean
  onSelectNone: () => void
  onSetCli: (cli: AgentCli) => void
  onSetModel: (model: string | null) => void
  onSetReasoning?: (reasoning: string | null) => void
}

export function PlainAgentsPanel({
  agentCount,
  onChangeAgentCount,
  cli,
  cliOptions,
  effectiveModel,
  effectiveReasoning,
  onSetCli,
  onSetModel,
  onSetReasoning,
  planningAgent,
  isolation,
  connectors,
}: {
  agentCount: number
  onChangeAgentCount?: (value: number) => void
  cli: AgentCli
  cliOptions: SprintEngineCliOption[]
  effectiveModel: string | undefined
  /** The pool's effort level. Opt-in as a pair with `onSetReasoning`. */
  effectiveReasoning?: string | undefined
  onSetCli: (cli: AgentCli) => void
  onSetModel?: (model: string | null) => void
  onSetReasoning?: (reasoning: string | null) => void
  planningAgent?: PlanningAgentRow
  /** The "Runs in" row (MC-2123). Opt-in for the same reason the planning row
   *  is: only the create surface chooses a run's isolation, and it is fixed
   *  once the team exists. */
  isolation?: SprintIsolationRow
  /** The "Connectors" row (MC-2124): which MCP servers the run's agents launch
   *  with. Opt-in like the two above, and rendered by the staffed card too. */
  connectors?: SprintConnectorsRow
}) {
  const clamp = (value: number) => Math.max(1, Math.min(10, Math.floor(value)))
  const setCount = (value: number) => {
    if (onChangeAgentCount) onChangeAgentCount(clamp(value))
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="min-w-0 text-body font-semibold text-[color:var(--text-strong)]">
            Max concurrent agents
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <AgentCountStepButton
              label="Fewer agents"
              glyph="−"
              disabled={!onChangeAgentCount || agentCount <= 1}
              onClick={() => setCount(agentCount - 1)}
            />
            <span className="w-7 text-center text-body font-semibold tabular-nums text-[color:var(--text-strong)]">
              {agentCount}
            </span>
            <AgentCountStepButton
              label="More agents"
              glyph="+"
              disabled={!onChangeAgentCount || agentCount >= 10}
              onClick={() => setCount(agentCount + 1)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-4 py-3">
          <span className="min-w-0 text-body font-semibold text-[color:var(--text-strong)]">Agent</span>
          {onSetModel ? (
            <CliModelPickerButton
              ariaLabel="Agent runtime"
              options={cliOptions}
              cli={cli}
              effectiveModelFor={(candidateCli) => (candidateCli === cli ? effectiveModel : undefined)}
              {...(onSetReasoning
                ? {
                    effectiveReasoningFor: (candidateCli: AgentCli) =>
                      candidateCli === cli ? effectiveReasoning : undefined,
                    onSelectReasoning: (_cli: AgentCli, reasoning: string | null) => onSetReasoning(reasoning),
                  }
                : {})}
              onSelectCli={onSetCli}
              onSelectModel={(nextCli, nextModel) => {
                if (nextCli !== cli) onSetCli(nextCli)
                onSetModel(nextModel)
              }}
            />
          ) : (
            <AgentCliSelect
              ariaLabel="Agent CLI"
              value={cli}
              disabled={false}
              cliOptions={cliOptions}
              onChange={onSetCli}
            />
          )}
        </div>
        {planningAgent ? (
          <PlanningAgentRowView row={planningAgent} cliOptions={cliOptions} />
        ) : null}
        {isolation ? <SprintIsolationRowView row={isolation} /> : null}
        {connectors ? <SprintConnectorsRowView row={connectors} /> : null}
      </div>
    </div>
  )
}

/**
 * The Planning-agent row itself (MC-2129), so the roleless team card and the
 * staffed roster card render one control rather than two that can drift. A row
 * of the card it sits in, exactly like Agents and Agent above it.
 */
export function PlanningAgentRowView({
  row,
  cliOptions,
}: {
  row: PlanningAgentRow
  cliOptions: SprintEngineCliOption[]
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-4 py-3">
      {/* No sub-copy and no badge (ruled 2026-08-04): the row's VALUE is the
          control, and the whole explanation lives on the label. */}
      <Tooltip content={PLANNING_AGENT_TOOLTIP}>
        <span
          tabIndex={0}
          className="min-w-0 rounded-[3px] text-body font-semibold text-[color:var(--text-strong)] focus-visible:focus-ring"
        >
          {PLANNING_AGENT_ROW_LABEL}
        </span>
      </Tooltip>
      <CliModelPickerButton
        ariaLabel={PLANNING_AGENT_ROW_LABEL}
        options={cliOptions}
        cli={row.cli}
        effectiveModelFor={(candidateCli) => (candidateCli === row.cli ? row.effectiveModel : undefined)}
        {...(row.onSetReasoning
          ? {
              effectiveReasoningFor: (candidateCli: AgentCli) =>
                candidateCli === row.cli ? row.effectiveReasoning : undefined,
              onSelectReasoning: (_cli: AgentCli, reasoning: string | null) =>
                row.onSetReasoning?.(reasoning),
            }
          : {})}
        {...(row.allowNone
          ? {
              noneOption: {
                label: PLANNING_AGENT_NONE_LABEL,
                description: PLANNING_AGENT_NONE_DESCRIPTION,
                selected: row.isNone,
                onSelect: row.onSelectNone,
              },
            }
          : {})}
        onSelectCli={row.onSetCli}
        onSelectModel={(nextCli, nextModel) => {
          if (nextCli !== row.cli) row.onSetCli(nextCli)
          row.onSetModel(nextModel)
        }}
      />
    </div>
  )
}

function AgentCountStepButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string
  glyph: string
  disabled: boolean
  onClick: () => void
}) {
  // The kit's outline button, squared: a bordered stepper is a secondary action
  // on the control ramp, not a private 28px button (audit, icon-buttons-off-
  // the-control-ramp). `aspect-square` lets the `xs` height set the width.
  return (
    <OutlineButton size="xs" aria-label={label} disabled={disabled} onClick={onClick} className="aspect-square">
      <span aria-hidden="true">{glyph}</span>
    </OutlineButton>
  )
}
