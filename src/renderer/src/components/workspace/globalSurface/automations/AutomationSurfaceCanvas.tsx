import { useEffect, useState } from 'react'

import {
  DefinitionList,
  GhostButton,
  InlineNotice,
  LifecycleGlyph,
  Section,
  Spinner,
  Tooltip,
  TruncatedText,
} from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
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

// The selected automation's canvas (mockup §3): the definition facts first —
// Trigger / Project / What runs / Prompt, unlabeled, a stable frame that never
// shifts as the selection changes — then the "Recent runs" timeline below. The
// surface bar above already carries the name, on/paused state, schedule, and
// Run now / Edit, so this canvas is purely "what it is" and "what happened" —
// no name or status is repeated here. Run
// history + finalize come from the shared `useAutomationRunHistory` hook, scoped
// to this entry's own store root, so a cross-project surface reads each
// automation from the project it lives in.
export function AutomationSurfaceCanvas({
  entry, now, focusRunId, focusNonce, onOpenAgent, onViewReport,
}: {
  entry: AutomationsInstanceEntry
  now: number
  /** A run to scroll into view and briefly highlight (notification deep link). */
  focusRunId?: string | null
  /** Changes on every deep-link apply so re-opening the same run re-fires the scroll. */
  focusNonce?: number
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
}): JSX.Element {
  const { definition, workspaceRoot } = entry
  const { runs, state, error, finalizingRunId, reload, finalize } = useAutomationRunHistory(workspaceRoot, definition)
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null)

  // Scroll the deep-linked run into view once history has loaded, and highlight
  // it briefly. Instant scroll (no smooth behaviour) so it is reduced-motion safe.
  useEffect(() => {
    if (state !== 'ready' || !focusRunId || !runs.some((run) => run.id === focusRunId)) return
    document.getElementById(`automation-surface-run-${focusRunId}`)?.scrollIntoView({ block: 'nearest' })
    setHighlightRunId(focusRunId)
    const timer = window.setTimeout(() => setHighlightRunId(null), 2400)
    return () => window.clearTimeout(timer)
  }, [state, focusRunId, focusNonce, runs])

  // What the automation actually asks its agent to do. The prompt/command live in
  // the action's config map; without this the only way to read them was opening
  // Edit — the canvas must say what the automation is for, not just when it runs.
  const config =
    definition.action.config && typeof definition.action.config === 'object'
      ? (definition.action.config as Record<string, unknown>)
      : {}
  const prompt = typeof config.prompt === 'string' && config.prompt.trim() ? config.prompt.trim() : null
  const command = typeof config.command === 'string' && config.command.trim() ? config.command.trim() : null

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto flex max-w-[720px] flex-col gap-4">
        {/* The definition facts lead, unlabeled — they are the stable frame, so
            swapping between automations never jumps the layout the way the
            variable-height run list would. What happened comes after. */}
        <div>
          {/* The kit's label / value rows — the same term column and type step
              every door frame uses, not a hand `<dl>` with its own gaps. */}
          <DefinitionList
            className="py-1"
            items={[
              { term: 'Trigger', description: <WhatValue value={cadenceSummary(definition.trigger)} /> },
              { term: 'Project', description: <WhatValue value={projectLabel(workspaceRoot)} /> },
              { term: 'What runs', description: <WhatValue value={actionLabel(definition.action.kind)} /> },
            ]}
          />
          {prompt ? (
            <div className="flex flex-col gap-1 pt-1.5">
              <span className="text-meta text-[color:var(--text-subtle)]">Prompt</span>
              <p className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2 text-meta leading-5 text-[color:var(--text-default)]">
                {prompt}
              </p>
            </div>
          ) : null}
          {command ? (
            <div className="flex flex-col gap-1 pt-1.5">
              <span className="text-meta text-[color:var(--text-subtle)]">Command</span>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2 font-mono text-meta leading-5 text-[color:var(--text-default)]">
                {command}
              </p>
            </div>
          ) : null}
        </div>
        <Section
          title="Recent runs"
          count={state === 'ready' ? runs.length : undefined}
          action={<GhostButton size="xs" onClick={() => void reload()}>Refresh</GhostButton>}
        >
          {state === 'loading' || state === 'idle' ? (
            <div className="flex items-center gap-2 py-3 text-micro text-[color:var(--text-muted)]">
              <Spinner size={12} label="Loading runs" /> Loading runs…
            </div>
          ) : state === 'error' ? (
            <InlineNotice tone="error" action={<GhostButton onClick={() => void reload()}>Retry</GhostButton>}>
              {error}
            </InlineNotice>
          ) : runs.length === 0 ? (
            <p className="py-3 text-micro leading-5 text-[color:var(--text-muted)]">
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
                  highlighted={run.id === highlightRunId}
                  onOpenAgent={onOpenAgent}
                  onViewReport={onViewReport}
                  onFinalize={finalize}
                  finalizing={finalizingRunId === run.id}
                />
              ))}
            </ol>
          )}
        </Section>

      </div>
    </div>
  )
}

// A value that clips to its row and reveals its full text only when it does —
// never a native `title` a keyboard cannot reach.
function WhatValue({ value }: { value: string }) {
  return <TruncatedText as="span" text={value} className="block min-w-0" />
}

// One run: shape-coded lifecycle glyph, the plain outcome + relative time, the
// run's own summary in plain words, and the trailing run affordances (open agent,
// view report, finalize a stuck run) reused from the folder panel.
function RunRow({ run, now, highlighted, onOpenAgent, onViewReport, onFinalize, finalizing }: {
  run: AutomationRun
  now: number
  highlighted: boolean
  onOpenAgent: (workspaceId: string, agentId?: string) => void
  onViewReport: (run: AutomationRun) => void
  onFinalize: (run: AutomationRun, outcome: 'completed' | 'failed') => void
  finalizing: boolean
}) {
  const stamp = parseTime(run.completedAt) ?? parseTime(run.startedAt) ?? parseTime(run.dueAt)
  return (
    <li
      id={`automation-surface-run-${run.id}`}
      className={[
        'flex items-start gap-2 border-b border-[color:var(--border-subtle)] py-2 transition-colors last:border-b-0',
        // The deep-linked row is SELECTED for a moment, and selection is
        // neutral — the accent is the primary action's, never a row fill.
        highlighted ? 'bg-[color:var(--bg-selected)]' : '',
      ].join(' ')}
    >
      <LifecycleGlyph
        state={RUN_LIFECYCLE[run.status]}
        live={run.status === 'running'}
        label={RUN_STATUS_LABEL[run.status]}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-meta font-medium text-[color:var(--text-strong)]">{RUN_STATUS_LABEL[run.status]}</span>
          {stamp !== null ? (
            // The absolute time rides the product tooltip on a focusable stamp,
            // so the keyboard reaches it too — never a native `title`.
            <Tooltip content={absoluteTime(stamp)} placement="left">
              <span
                tabIndex={0}
                className={`shrink-0 rounded-xs tabular-nums text-micro text-[color:var(--text-subtle)] ${FOCUS_RING_CLASS}`}
              >
                {relativeFromNow(stamp, now)}
              </span>
            </Tooltip>
          ) : null}
        </div>
        {run.summary ? (
          <TruncatedText
            as="p"
            multiline
            text={run.summary}
            className="mt-0.5 line-clamp-2 text-micro leading-4 text-[color:var(--text-muted)]"
          />
        ) : null}
        {run.blockedReason ? (
          // Degraded, not failed: the warn notice with its glyph, never amber
          // ink alone (`principles.md` → Status is earned).
          <InlineNotice tone="warn" className="mt-1">
            {run.blockedReason}
          </InlineNotice>
        ) : null}
        <AutomationRunActions run={run} onOpenAgent={onOpenAgent} onViewReport={onViewReport} onFinalize={onFinalize} finalizing={finalizing} />
      </div>
    </li>
  )
}
