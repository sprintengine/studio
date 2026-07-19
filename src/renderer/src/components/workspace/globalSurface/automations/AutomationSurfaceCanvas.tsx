import { GhostButton, InlineNotice, LifecycleGlyph, Section, Spinner, TruncatedText } from '../../../ui'
import type { AutomationRun, AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { AutomationRunActions } from '../../../panels/AutomationsPanel/AutomationRunActions'
import { useAutomationRunHistory } from '../../../panels/AutomationsPanel/useAutomationRunHistory'
import {
  RUN_LIFECYCLE,
  RUN_STATUS_LABEL,
  absoluteTime,
  actionLabel,
  cadenceSummary,
  parseTime,
  relativeFromNow,
} from '../../../panels/AutomationsPanel/automationsFormat'
import { projectLabel } from './railState'

// The selected automation's canvas (mockup §3): a "Recent runs" timeline and a
// plain-language "What it does" panel. The surface bar above already carries the
// name, on/paused state, schedule, and Run now / Edit, so this canvas is purely
// "what happened" and "what it is" — no name or status is repeated here. Run
// history + finalize come from the shared `useAutomationRunHistory` hook, scoped
// to this entry's own store root, so a cross-project surface reads each
// automation from the project it lives in.
export function AutomationSurfaceCanvas({
  entry, now, onOpenAgent, onViewReport,
}: {
  entry: AutomationsInstanceEntry
  now: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
}): JSX.Element {
  const { definition, workspaceRoot } = entry
  const { runs, state, error, finalizingRunId, reload, finalize } = useAutomationRunHistory(workspaceRoot, definition)

  const autonomy = definition.autonomyDefault === 'allow_changes' ? 'can make changes' : 'review only'

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="flex max-w-[720px] flex-col gap-4">
        <Section
          title="Recent runs"
          count={state === 'ready' ? runs.length : undefined}
          action={<GhostButton onClick={() => void reload()} className="h-6 px-2 text-[11px]">Refresh</GhostButton>}
        >
          {state === 'loading' || state === 'idle' ? (
            <div className="flex items-center gap-2 py-3 text-[11px] text-[color:var(--text-muted)]">
              <Spinner size={12} label="Loading runs" /> Loading runs…
            </div>
          ) : state === 'error' ? (
            <InlineNotice tone="error" action={<GhostButton onClick={() => void reload()}>Retry</GhostButton>}>
              {error}
            </InlineNotice>
          ) : runs.length === 0 ? (
            <p className="py-3 text-[11px] leading-5 text-[color:var(--text-muted)]">
              {definition.status === 'enabled'
                ? 'No runs yet. The first one appears here when the schedule fires or you run it now.'
                : 'No runs yet. Turn the automation on to schedule runs, or run it now.'}
            </p>
          ) : (
            <ol className="flex flex-col">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  now={now}
                  onOpenAgent={onOpenAgent}
                  onViewReport={onViewReport}
                  onFinalize={finalize}
                  finalizing={finalizingRunId === run.id}
                />
              ))}
            </ol>
          )}
        </Section>

        <Section title="What it does">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 py-1 text-[12px]">
            <WhatRow label="Trigger" value={cadenceSummary(definition.trigger)} />
            <WhatRow label="Project" value={projectLabel(workspaceRoot)} />
            <WhatRow label="What runs" value={`${actionLabel(definition.action.kind)} · ${autonomy}`} />
          </dl>
        </Section>
      </div>
    </div>
  )
}

function WhatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[color:var(--text-subtle)]">{label}</dt>
      <dd className="min-w-0 truncate text-[color:var(--text-default)]" title={value}>{value}</dd>
    </>
  )
}

// One run: shape-coded lifecycle glyph, the plain outcome + relative time, the
// run's own summary in plain words, and the trailing run affordances (open agent,
// view report, finalize a stuck run) reused from the folder panel.
function RunRow({ run, now, onOpenAgent, onViewReport, onFinalize, finalizing }: {
  run: AutomationRun
  now: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
  onFinalize: (run: AutomationRun, outcome: 'completed' | 'failed') => void
  finalizing: boolean
}) {
  const stamp = parseTime(run.completedAt) ?? parseTime(run.startedAt) ?? parseTime(run.dueAt)
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
          <span className="text-[12px] font-medium text-[color:var(--text-strong)]">{RUN_STATUS_LABEL[run.status]}</span>
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
