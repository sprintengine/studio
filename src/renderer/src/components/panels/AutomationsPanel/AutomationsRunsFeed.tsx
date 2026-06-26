import { useState } from 'react'

import { GhostButton, InlineNotice, LifecycleGlyph, Spinner, TruncatedText } from '../../ui'
import { AutomationRunActions } from './AutomationRunActions'
import {
  RUN_LIFECYCLE,
  RUN_STATUS_LABEL,
  TRIGGER_FAMILY_LABEL,
  absoluteTime,
  feedRunStamp,
  relativeFromNow,
  runDuration,
  type AsyncState,
  type AutomationFeedRun,
} from './automationsFormat'

// Cross-definition runs feed: recent runs across every automation in the
// project, newest first. The investigation surface for "what has the engine been
// doing", complementing the per-definition timeline in the detail pane.
export function AutomationsRunsFeed({
  feedRuns, state, error, partialCount, now, onReload, onOpenAgent, onOpenDefinition, onFinalize,
}: {
  feedRuns: AutomationFeedRun[]
  state: AsyncState
  error: string | null
  partialCount: number
  now: number
  onReload: () => void
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  /** Drill into a run's owning definition: open the Definitions view, select it,
   *  and focus the run in its detail timeline. */
  onOpenDefinition: (automationId: string, runId: string) => void
  onFinalize: (automationId: string, runId: string, outcome: 'completed' | 'failed') => Promise<void>
}) {
  const [finalizingRunId, setFinalizingRunId] = useState<string | null>(null)

  const finalize = async (automationId: string, runId: string, outcome: 'completed' | 'failed') => {
    setFinalizingRunId(runId)
    try {
      await onFinalize(automationId, runId, outcome)
    } finally {
      setFinalizingRunId(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--border-subtle)] px-4 py-2">
        <span className="text-[11px] font-medium text-[color:var(--text-muted)]">
          Recent runs{state === 'ready' ? ` · ${feedRuns.length}` : ''}
        </span>
        <GhostButton onClick={onReload} className="h-6 px-2 text-[11px]">Refresh</GhostButton>
      </div>

      {partialCount > 0 ? (
        <div className="px-4 pt-3">
          <InlineNotice tone="warn">
            {partialCount === 1
              ? 'One automation’s run history could not be loaded; its runs are missing from this feed.'
              : `${partialCount} automations’ run history could not be loaded; their runs are missing from this feed.`}
          </InlineNotice>
        </div>
      ) : null}

      {state === 'loading' || state === 'idle' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
          <Spinner size={14} label="Loading runs" />
          Loading runs…
        </div>
      ) : state === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-sm text-[11px] leading-5 text-[color:var(--tone-error)]">{error}</p>
          <GhostButton onClick={onReload}>Retry</GhostButton>
        </div>
      ) : feedRuns.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[12px] font-medium text-[color:var(--text-strong)]">No runs yet</p>
          <p className="max-w-[18rem] text-[11px] leading-5 text-[color:var(--text-muted)]">
            Runs appear here once an automation fires — on schedule, on an event, or from Run now.
          </p>
        </div>
      ) : (
        <ul aria-label="Recent automation runs" className="min-h-0 flex-1 overflow-y-auto px-4">
          {feedRuns.map((entry) => (
            <FeedRow
              key={`${entry.definitionId}:${entry.run.id}`}
              entry={entry}
              now={now}
              onOpenAgent={onOpenAgent}
              onOpenDefinition={onOpenDefinition}
              onFinalize={(run, outcome) => void finalize(entry.definitionId, run.id, outcome)}
              finalizing={finalizingRunId === entry.run.id}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function FeedRow({
  entry, now, onOpenAgent, onOpenDefinition, onFinalize, finalizing,
}: {
  entry: AutomationFeedRun
  now: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onOpenDefinition: (automationId: string, runId: string) => void
  onFinalize: (run: AutomationFeedRun['run'], outcome: 'completed' | 'failed') => void
  finalizing: boolean
}) {
  const { run, definitionId, definitionName, triggerKind } = entry
  const family = TRIGGER_FAMILY_LABEL[triggerKind] ?? triggerKind
  const duration = runDuration(run)
  const stamp = feedRunStamp(run)

  return (
    <li className="flex items-start gap-2 border-b border-[color:var(--border-subtle)] py-2 last:border-b-0">
      <LifecycleGlyph
        state={RUN_LIFECYCLE[run.status]}
        live={run.status === 'running'}
        label={RUN_STATUS_LABEL[run.status]}
        className="mt-[1px] translate-y-[1px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          {/* The name drills into the owning definition: opens the Definitions
              view, selects it, and focuses this run in its detail timeline. */}
          <button
            type="button"
            onClick={() => onOpenDefinition(definitionId, run.id)}
            className="flex min-w-0 rounded-sm text-left outline-none hover:underline focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]"
          >
            <TruncatedText as="span" text={definitionName} className="text-[12px] font-medium text-[color:var(--text-strong)]" />
          </button>
          <span className="shrink-0 tabular-nums text-[10px] text-[color:var(--text-subtle)]">
            {duration ?? '—'}
            {stamp !== null ? (
              <span title={absoluteTime(stamp)}> · {relativeFromNow(stamp, now)}</span>
            ) : null}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
          <span className="text-[color:var(--text-subtle)]">{family}</span>
          <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">·</span>
          {RUN_STATUS_LABEL[run.status]}
        </div>
        {run.summary ? (
          <TruncatedText
            as="p"
            multiline
            text={run.summary}
            className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[color:var(--text-muted)]"
          />
        ) : null}
        {run.blockedReason ? (
          <p className="mt-0.5 text-[11px] leading-4 text-[color:var(--tone-warn)]">{run.blockedReason}</p>
        ) : null}
        <AutomationRunActions run={run} onOpenAgent={onOpenAgent} onFinalize={onFinalize} finalizing={finalizing} />
      </div>
    </li>
  )
}
