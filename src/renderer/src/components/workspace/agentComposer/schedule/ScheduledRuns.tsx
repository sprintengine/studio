import React from 'react'

import { LifecycleGlyph, RowButton, Section, WorkingMark } from '../../../ui'
import { useRelativeNow } from '../../../../hooks/useRelativeNow'
import { formatRelativeMsAgo } from '../../../../utils/relativeTime'
import type { ScheduledRunEntry } from '../../../../utils/scheduledAgentRuns'

/**
 * A scheduled agent's recent runs, under its editor: each one the chat it
 * started, newest first, a handful at most. A run is an ordinary chat, so a
 * row opens that chat — this is where the person who opened the schedule to
 * find its run is sent on to it. The one still going wears the working mark
 * (or the needs-input glyph) in the leading slot, the same marks its chat row
 * wears in the sidebar; the trailing meta is when it started.
 *
 * Nothing is drawn until a run has a chat here: a schedule that has not run,
 * or whose runs have all been closed, has nothing to list.
 */
export function ScheduledRuns({
  runs,
  onOpen,
}: {
  runs: readonly ScheduledRunEntry[]
  onOpen: (workspaceId: string) => void
}) {
  const now = useRelativeNow()
  if (runs.length === 0) return null
  return (
    <Section title="Recent runs" inset="flush" className="mt-6">
      <ul className="flex flex-col" aria-label="Recent runs">
        {runs.map((run) => (
          <li key={run.workspaceId}>
            <RowButton data-scheduled-run-row={run.workspaceId} onClick={() => onOpen(run.workspaceId)}>
              <span className="flex size-icon-sm shrink-0 items-center justify-center">
                {run.activity === 'working' ? (
                  <WorkingMark label="Working" seed={run.workspaceId} />
                ) : run.activity === 'needs-input' ? (
                  <LifecycleGlyph state="needs_input" live={false} label="Waiting on you" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-body">{run.title}</span>
              <span className="shrink-0 text-meta tabular-nums text-[color:var(--text-muted)]">
                {formatRelativeMsAgo(run.startedAt, now)}
              </span>
            </RowButton>
          </li>
        ))}
      </ul>
    </Section>
  )
}
