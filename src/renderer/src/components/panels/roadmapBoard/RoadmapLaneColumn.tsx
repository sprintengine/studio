// One lane ("track") on the roadmap board: its progress, the steering controls
// grouped by consequence, the ordered units, and — for a lane with a running
// sprint — the first-class pull-request surface. Every control is a file/store
// write the orchestrator reconciles against (approve / pause / resume / merge write
// orchestrator state; skip edits the roadmap file; edit-plan opens the authoring
// editor) — never an imperative side-channel.

import React from 'react'

import { LifecycleGlyph, type LifecycleState } from '../../ui'
import type { RoadmapBoardLane, RoadmapBoardUnit, RoadmapUnitState } from '../../../../../shared/sprintengine/roadmap-surface'
import { RoadmapPullRequests } from './RoadmapPullRequests'
import { useLaneRun } from './roadmapBoardData'

const UNIT_LIFECYCLE: Record<RoadmapUnitState, LifecycleState> = {
  done: 'done',
  running: 'in_progress',
  up_next: 'ready',
  queued: 'todo',
  paused: 'paused',
  unknown: 'blocked',
  unknown_project: 'blocked',
}

const PARK_REASON_COPY: Record<string, string> = {
  run_failed: 'A sprint failed.',
  run_canceled: 'A sprint was canceled.',
  needs_input: 'A sprint is waiting on your input.',
  pr_closed: 'A pull request was closed without merging.',
  merge_failed: 'A merge could not complete.',
  start_failed: 'The next sprint could not start.',
  eligibility_contradiction: 'This track points at an item that no longer exists.',
  paused: 'You paused this track.',
}

export type RoadmapLaneCallbacks = {
  onApprove: (lane: string) => void
  onPause: (lane: string) => void
  onResume: (lane: string) => void
  onMerge: (lane: string) => void
  onSkip: (lane: string, unit: RoadmapBoardUnit) => void
  onEditPlan: () => void
  onOpenRun: (statePath: string) => void
  /** True while a command for this lane is in flight (disables its controls). */
  busyLane: string | null
}

export function RoadmapLaneColumn({
  lane,
  folderPath,
  callbacks,
  onReloadBoard,
}: {
  lane: RoadmapBoardLane
  folderPath: string | null
  callbacks: RoadmapLaneCallbacks
  onReloadBoard: () => void
}): JSX.Element {
  const busy = callbacks.busyLane === lane.lane
  return (
    <section
      className="flex min-w-[280px] max-w-[340px] flex-1 flex-col rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      aria-label={`Track: ${lane.lane}`}
    >
      <header className="flex flex-col gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[color:var(--text-strong)]" title={lane.lane}>
            {lane.lane}
          </h3>
          <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-muted)]">
            {lane.doneCount}/{lane.total}
          </span>
        </div>
        <LaneControls lane={lane} busy={busy} callbacks={callbacks} />
      </header>

      {lane.parked ? (
        <div className="flex flex-col gap-0.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--tone-warn-soft)] px-3 py-2">
          <span className="text-[11px] font-semibold text-[color:var(--tone-warn)]">Paused</span>
          <span className="text-[11px] leading-4 text-[color:var(--text-muted)]">
            {PARK_REASON_COPY[lane.parked.reason] ?? 'This track is paused.'}
            {lane.parked.reason !== 'paused' ? ' Resume to continue.' : ''}
          </span>
        </div>
      ) : null}

      <ul className="flex flex-col py-1">
        {lane.units.length === 0 ? (
          <li className="px-3 py-3 text-[12px] text-[color:var(--text-muted)]">
            This track has no steps yet.
          </li>
        ) : (
          lane.units.map((unit, index) => (
            <li key={`${unit.ref}:${index}`}>
              <RoadmapUnitRow
                unit={unit}
                lane={lane.lane}
                busy={busy}
                onSkip={() => callbacks.onSkip(lane.lane, unit)}
                onOpenRun={
                  unit.state === 'running' && lane.activeStatePath
                    ? () => callbacks.onOpenRun(lane.activeStatePath as string)
                    : undefined
                }
              />
            </li>
          ))
        )}
      </ul>

      {lane.activeStatePath ? (
        <LanePullRequests
          statePath={lane.activeStatePath}
          folderPath={folderPath}
          onMerged={onReloadBoard}
        />
      ) : null}
    </section>
  )
}

function LaneControls({
  lane,
  busy,
  callbacks,
}: {
  lane: RoadmapBoardLane
  busy: boolean
  callbacks: RoadmapLaneCallbacks
}): JSX.Element {
  const paused = Boolean(lane.parked)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Advance: the one primary action the lane's state implies. */}
      {paused ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => callbacks.onResume(lane.lane)}
          className={primaryControlClass}
        >
          Resume
        </button>
      ) : lane.attention === 'approval' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => callbacks.onApprove(lane.lane)}
          className={primaryControlClass}
        >
          Start next
        </button>
      ) : lane.attention === 'merge' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => callbacks.onMerge(lane.lane)}
          className={primaryControlClass}
        >
          Approve &amp; merge
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => callbacks.onPause(lane.lane)}
          className={secondaryControlClass}
        >
          Pause
        </button>
      )}
      {/* Secondary: editing the plan is always available. */}
      <button
        type="button"
        disabled={busy}
        onClick={callbacks.onEditPlan}
        className={secondaryControlClass}
      >
        Edit plan
      </button>
    </div>
  )
}

const primaryControlClass =
  'interactive rounded border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]'
const secondaryControlClass =
  'interactive rounded border border-[color:var(--border-default)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]'

function RoadmapUnitRow({
  unit,
  lane,
  busy,
  onSkip,
  onOpenRun,
}: {
  unit: RoadmapBoardUnit
  lane: string
  busy: boolean
  onSkip: () => void
  onOpenRun?: () => void
}): JSX.Element {
  const isDone = unit.state === 'done'
  const canSkip = unit.state === 'up_next' || unit.state === 'queued' || unit.state === 'unknown'
  return (
    <div className="group relative flex items-center gap-2 px-3 py-1.5">
      <LifecycleGlyph state={UNIT_LIFECYCLE[unit.state]} live={unit.state === 'running'} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-[12px] ${isDone ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-default)]'}`}
            title={unit.title}
          >
            {unit.title}
          </span>
          {unit.epicRef ? (
            <span className="shrink-0 text-[10px] leading-4 text-[color:var(--text-subtle)]">epic</span>
          ) : null}
          {unit.state === 'unknown' ? (
            <span className="shrink-0 text-[10px] font-medium text-[color:var(--tone-warn)]">Unknown</span>
          ) : null}
        </div>
      </div>
      {/* Trailing, hover-revealed actions — kept off the row at rest. */}
      {onOpenRun ? (
        <button
          type="button"
          onClick={onOpenRun}
          className="interactive shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--accent-primary-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
          aria-label={`Open the running sprint for ${unit.title}`}
        >
          Open sprint
        </button>
      ) : null}
      {unit.prUrl && isDone ? (
        <a
          href={unit.prUrl}
          target="_blank"
          rel="noreferrer"
          className="interactive shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[color:var(--accent-primary)] opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={`View the pull request for ${unit.title}`}
        >
          PR
        </a>
      ) : null}
      {canSkip ? (
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          aria-label={`Skip ${unit.title} in ${lane}`}
          className="interactive shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[color:var(--text-muted)] opacity-0 transition-opacity hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
        >
          Skip
        </button>
      ) : null}
    </div>
  )
}

// The lane's running sprint drives its own read of the run projection (vcs +
// tasks) — kept in this leaf so only the active lane pays for the extra read.
function LanePullRequests({
  statePath,
  folderPath,
  onMerged,
}: {
  statePath: string
  folderPath: string | null
  onMerged: () => void
}): JSX.Element | null {
  const { vcs, blockers, loading, error, reload } = useLaneRun(statePath)
  if (loading && !vcs) {
    return (
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-[11px] text-[color:var(--text-muted)]">
        Loading pull requests…
      </div>
    )
  }
  if (error) {
    return (
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2 text-[11px] text-[color:var(--tone-warn)]">
        Could not read this sprint’s pull requests: {error}
      </div>
    )
  }
  if (!vcs) return null
  return (
    <div className="border-t border-[color:var(--border-subtle)]">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[11px] font-semibold text-[color:var(--text-subtle)]">Pull requests</span>
      </div>
      <RoadmapPullRequests
        vcs={vcs}
        blockers={blockers}
        statePath={statePath}
        folderPath={folderPath}
        onMerged={() => {
          reload()
          onMerged()
        }}
      />
    </div>
  )
}
