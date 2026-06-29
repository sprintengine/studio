import { useCallback, useEffect, useState } from 'react'

import { GhostButton, InlineNotice, LifecycleGlyph, Section, Spinner, TruncatedText } from '../../ui'
import type { AutomationDefinition, AutomationRun } from '../../../../../shared/automations/contracts'
import { AutomationRunActions } from './AutomationRunActions'
import {
  DEFINITION_LIFECYCLE,
  DEFINITION_STATUS_LABEL,
  RUN_LIFECYCLE,
  RUN_STATUS_LABEL,
  type AsyncState,
  absoluteTime,
  actionLabel,
  cadenceSummary,
  parseTime,
  relativeFromNow,
} from './automationsFormat'

// Selected definition's run timeline + summary. Loads run history through the
// `window.api` automations bridge; reloads whenever the definition's lastRunId
// changes (e.g. after a run-now).
export function AutomationDetailPane({
  definition, workspaceRoot, now, focusRunId, focusNonce, onOpenAgent, onViewReport,
}: {
  definition: AutomationDefinition
  workspaceRoot: string
  now: number
  /** A run to scroll into view and briefly highlight (notification deep link). */
  focusRunId?: string | null
  /** Changes on every Open action so re-opening the same run re-fires the scroll. */
  focusNonce?: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  /** Open a run's report in the in-app viewer. */
  onViewReport: (run: AutomationRun) => void
}) {
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [state, setState] = useState<AsyncState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null)
  const [finalizingRunId, setFinalizingRunId] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    if (!workspaceRoot) return
    setState('loading')
    setError(null)
    try {
      const result = await window.api.listAutomationRuns({ workspaceRoot, automationId: definition.id })
      if (!result.ok) {
        setState('error')
        setError(result.message)
        return
      }
      // Newest first for the timeline.
      setRuns([...result.value].sort((a, b) => (parseTime(b.dueAt) ?? 0) - (parseTime(a.dueAt) ?? 0)))
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    }
  }, [workspaceRoot, definition.id, definition.lastRunId])

  useEffect(() => { void loadRuns() }, [loadRuns])

  // Finalize an in-progress agent-backed run: records the terminal outcome and
  // (for `completed`) backstop-commits + opens/links a PR for the run's branch.
  const finalizeRun = useCallback(async (run: AutomationRun, outcome: 'completed' | 'failed') => {
    if (!workspaceRoot) return
    setFinalizingRunId(run.id)
    setError(null)
    try {
      const result = await window.api.finalizeAutomationRun({
        workspaceRoot,
        automationId: definition.id,
        runId: run.id,
        outcome,
      })
      if (!result.ok) setError(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setFinalizingRunId(null)
      await loadRuns()
    }
  }, [workspaceRoot, definition.id, loadRuns])

  // Scroll the deep-linked run into view once history has loaded, and highlight
  // it briefly so the eye lands on it. Instant scroll (no smooth behaviour) so
  // it is reduced-motion safe.
  useEffect(() => {
    if (state !== 'ready' || !focusRunId || !runs.some((run) => run.id === focusRunId)) return
    document.getElementById(`automation-run-${focusRunId}`)?.scrollIntoView({ block: 'nearest' })
    setHighlightRunId(focusRunId)
    const timer = window.setTimeout(() => setHighlightRunId(null), 2400)
    return () => window.clearTimeout(timer)
  }, [state, focusRunId, focusNonce, runs])

  const nextAt = parseTime(definition.nextRunAt)
  const lastAt = parseTime(definition.lastRunAt)

  return (
    <div className="flex flex-col">
      <div className="border-b border-[color:var(--border-default)] px-4 py-3">
        <div className="flex items-center gap-2">
          <LifecycleGlyph
            state={DEFINITION_LIFECYCLE[definition.status]}
            live={definition.status === 'enabled'}
            label={DEFINITION_STATUS_LABEL[definition.status]}
          />
          <h3 className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{definition.name}</h3>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <Meta label="Trigger" value={cadenceSummary(definition.trigger)} />
          <Meta label="Action" value={`${actionLabel(definition.action.kind)} · ${definition.autonomyDefault === 'allow_changes' ? 'Allow changes' : 'Review only'}`} />
          <Meta label="Next run" value={nextAt !== null ? `${relativeFromNow(nextAt, now)} (${absoluteTime(nextAt)})` : definition.status === 'enabled' ? 'Pending' : 'Paused'} />
          <Meta label="Last run" value={lastAt !== null ? `${relativeFromNow(lastAt, now)} (${absoluteTime(lastAt)})` : 'Never run'} />
        </dl>
        {definition.status === 'blocked' ? (
          <div className="mt-2">
            <InlineNotice tone="warn">
              This automation is blocked and will not fire until the cause is resolved. See the latest run below.
            </InlineNotice>
          </div>
        ) : null}
      </div>

      <Section title="Run history" count={state === 'ready' ? runs.length : undefined} action={<GhostButton onClick={() => void loadRuns()} className="h-6 px-2 text-[11px]">Refresh</GhostButton>}>
        {state === 'loading' || state === 'idle' ? (
          <div className="flex items-center gap-2 py-3 text-[11px] text-[color:var(--text-muted)]">
            <Spinner size={12} label="Loading runs" /> Loading runs…
          </div>
        ) : state === 'error' ? (
          <InlineNotice tone="error" action={<GhostButton onClick={() => void loadRuns()}>Retry</GhostButton>}>
            {error}
          </InlineNotice>
        ) : runs.length === 0 ? (
          <p className="py-3 text-[11px] leading-5 text-[color:var(--text-muted)]">
            No runs yet. {definition.status === 'enabled' ? 'The first run will appear here when the schedule fires or you run it now.' : 'Enable the automation to schedule runs.'}
          </p>
        ) : (
          <ol className="flex flex-col">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                highlighted={run.id === highlightRunId}
                onOpenAgent={onOpenAgent}
                onViewReport={onViewReport}
                onFinalize={finalizeRun}
                finalizing={finalizingRunId === run.id}
              />
            ))}
          </ol>
        )}
      </Section>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd className="min-w-0 truncate text-[color:var(--text-default)]" title={value}>{value}</dd>
    </>
  )
}

// Watchtower-style run row: leading lifecycle glyph (shape-coded), identifier in
// mono, timing in tabular figures, and a trailing "Open agent" when a run
// launched one.
function RunRow({ run, now, highlighted, onOpenAgent, onViewReport, onFinalize, finalizing }: {
  run: AutomationRun
  now: number
  highlighted: boolean
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
  onFinalize: (run: AutomationRun, outcome: 'completed' | 'failed') => void
  finalizing: boolean
}) {
  const dueAt = parseTime(run.dueAt)
  const startedAt = parseTime(run.startedAt)
  const completedAt = parseTime(run.completedAt)
  const stamp = completedAt ?? startedAt ?? dueAt

  return (
    <li
      id={`automation-run-${run.id}`}
      className={[
        'flex items-start gap-2 border-b border-[color:var(--border-subtle)] py-2 transition-colors last:border-b-0',
        highlighted ? 'bg-[color:var(--accent-primary-soft)]' : '',
      ].join(' ')}
    >
      <LifecycleGlyph
        state={RUN_LIFECYCLE[run.status]}
        live={run.status === 'running'}
        label={RUN_STATUS_LABEL[run.status]}
        className="mt-[1px] translate-y-[1px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-medium text-[color:var(--text-strong)]">{RUN_STATUS_LABEL[run.status]}</span>
          {stamp !== null ? (
            <span className="shrink-0 tabular-nums text-[10px] text-[color:var(--text-subtle)]" title={absoluteTime(stamp)}>
              {relativeFromNow(stamp, now)}
            </span>
          ) : null}
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
        <AutomationRunActions run={run} onOpenAgent={onOpenAgent} onViewReport={onViewReport} onFinalize={onFinalize} finalizing={finalizing} />
      </div>
    </li>
  )
}
