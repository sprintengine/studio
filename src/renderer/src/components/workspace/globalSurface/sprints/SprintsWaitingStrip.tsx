// "Waiting on you" for the Sprints door (item 1764, mockup §2): the one strip
// that answers "what needs me right now?" across EVERY run in this Multicode, not
// just the one filling the canvas. That is the whole point of the door — a run
// parked on a question in a project you closed last week is exactly the run you
// would otherwise never see.
//
// It is a summary, never a second control set (the Roadmap inbox rule): a row
// names its run and jumps the rail to it, and the action itself — answer the
// question, merge the branch — lives on that run's own canvas.

import { InboxRow, LifecycleGlyph, type LifecycleState } from '../../../ui'
import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { sprintRunProjectPhrase } from './railState'

export type SprintWaitingKind = 'input' | 'merge'

export type SprintWaitingRow = {
  /** The run's statePath — the rail's selection id. */
  statePath: string
  kind: SprintWaitingKind
  runName: string
  supporting: string
  trailing: string
}

const WAITING_GLYPH: Record<SprintWaitingKind, LifecycleState> = {
  input: 'needs_input',
  merge: 'review',
}

/**
 * Every run that is waiting on the operator, in attention order: questions first
 * (a stopped run costs more than an unmerged branch), then branches ready to
 * land, each group by run name so the strip does not reshuffle between refreshes.
 * A run can contribute both rows — a paused question and an open branch are two
 * different asks.
 *
 * Pure over the run-index summaries, so the aggregate is unit-testable and never
 * fans out a per-run read.
 */
export function collectSprintWaitingRows(
  summaries: ReadonlyArray<SprintRunSummary>,
): SprintWaitingRow[] {
  const input: SprintWaitingRow[] = []
  const merge: SprintWaitingRow[] = []
  for (const summary of summaries) {
    const where = sprintRunProjectPhrase(summary)
    if (summary.needsInputCount > 0) {
      input.push({
        statePath: summary.statePath,
        kind: 'input',
        runName: summary.teamName,
        supporting: `${where} · ${
          summary.needsInputCount === 1 ? 'a task needs' : `${summary.needsInputCount} tasks need`
        } an answer`,
        trailing: 'Needs you',
      })
    }
    // Merge-ready means the work is finished and only the landing is left. A run
    // still working its plan has open branches by design — surfacing those would
    // make the strip permanent noise.
    if (summary.runtimeState === 'completed' && summary.repoRollup.open > 0) {
      merge.push({
        statePath: summary.statePath,
        kind: 'merge',
        runName: summary.teamName,
        supporting: `${where} · ${
          summary.repoRollup.open === 1 ? 'one branch' : `${summary.repoRollup.open} branches`
        } left to merge`,
        trailing: 'Ready to merge',
      })
    }
  }
  const byName = (a: SprintWaitingRow, b: SprintWaitingRow): number => a.runName.localeCompare(b.runName)
  return [...input.sort(byName), ...merge.sort(byName)]
}

export function SprintsWaitingStrip({
  rows,
  selectedStatePath,
  onSelect,
}: {
  rows: ReadonlyArray<SprintWaitingRow>
  selectedStatePath: string | null
  onSelect: (statePath: string) => void
}): JSX.Element {
  return (
    <ul aria-label="Waiting on you">
      {rows.map((row) => (
        <li key={`${row.statePath}:${row.kind}`}>
          <InboxRow
            leading={<LifecycleGlyph state={WAITING_GLYPH[row.kind]} />}
            title={row.runName}
            supporting={row.supporting}
            trailing={row.trailing}
            selected={row.statePath === selectedStatePath}
            ariaLabel={`${row.runName}: ${row.supporting}`}
            onSelect={() => onSelect(row.statePath)}
          />
        </li>
      ))}
    </ul>
  )
}
