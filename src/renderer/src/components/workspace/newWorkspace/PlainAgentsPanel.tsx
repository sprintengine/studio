// The plain-agents ("No roles") configuration: how many agents share the run
// (bound to the concurrency cap, not a roster count) and which agent + model
// they all run. Moved out of SprintEngineRosterPanel with MC-2064 — "No roles"
// is not a roster, so its controls live on the create surface, the only place
// a plain-agent run is configured. Exactly two rows and no explanatory copy
// (MC-2062): there is nothing to step into, so the card must read at a glance.

import type { AgentCli } from '../../../types/workspace'
import { CliModelPickerButton } from '../../ui'
import { AgentCliPicker, type SprintEngineCliOption } from './SprintEngineRosterTable'

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
}) {
  const clamp = (value: number) => Math.max(1, Math.min(10, Math.floor(value)))
  const setCount = (value: number) => {
    if (onChangeAgentCount) onChangeAgentCount(clamp(value))
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
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
        <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-3.5 py-3">
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
            <AgentCliPicker
              ariaLabel="Agent CLI"
              value={cli}
              disabled={false}
              cliOptions={cliOptions}
              onChange={onSetCli}
            />
          )}
        </div>
      </div>
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
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="
        inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--color-5)]
        bg-[color:var(--bg-surface-raised)] text-heading leading-none text-[color:var(--text-default)] transition-colors
        hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
        focus-visible:focus-ring
        disabled:cursor-not-allowed disabled:opacity-45
      "
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}
