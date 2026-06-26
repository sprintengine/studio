import { GhostButton, Tooltip } from '../../ui'
import type { AutomationRun } from '../../../../../shared/automations/contracts'

// The trailing run affordances shared by the per-definition timeline (detail
// pane) and the cross-definition runs feed: the launched agent id, Open agent,
// the Pull request link, and the manual Finalize fallback for a running agent.
// Rendered only when a run has something actionable.
export function AutomationRunActions({
  run, onOpenAgent, onFinalize, finalizing,
}: {
  run: AutomationRun
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onFinalize: (run: AutomationRun, outcome: 'completed' | 'failed') => void
  finalizing: boolean
}) {
  if (!(run.workspaceId || run.agentId || run.pullRequestUrl) && run.status !== 'running') return null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {run.agentId ? (
        <span className="truncate font-mono text-[10px] text-[color:var(--text-subtle)]">{run.agentId}</span>
      ) : null}
      {run.workspaceId ? (
        <GhostButton onClick={() => onOpenAgent(run.workspaceId!, run.agentId ?? undefined)} className="h-5 px-1.5 text-[10px]">
          Open agent
        </GhostButton>
      ) : null}
      {run.pullRequestUrl ? (
        <Tooltip content={run.pullRequestUrl}>
          <a
            href={run.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-[color:var(--accent-primary)] hover:underline"
          >
            Pull request
          </a>
        </Tooltip>
      ) : null}
      {run.status === 'running' ? (
        <>
          <GhostButton
            onClick={() => onFinalize(run, 'completed')}
            disabled={finalizing}
            className="h-5 px-1.5 text-[10px]"
          >
            {finalizing ? 'Finalizing…' : 'Finalize & open PR'}
          </GhostButton>
          <p className="basis-full text-[10px] leading-4 text-[color:var(--text-subtle)]">
            Finalizes automatically when the agent reports done — this manual control is a fallback.
          </p>
        </>
      ) : null}
    </div>
  )
}
