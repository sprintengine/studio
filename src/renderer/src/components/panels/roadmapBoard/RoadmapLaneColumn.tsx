// One lane ("track") on the roadmap board: its progress, the steering controls
// grouped by consequence, the ordered units, and — for a lane with a running
// sprint — the first-class pull-request surface. Every control is a file/store
// write the orchestrator reconciles against (approve / pause / resume / merge write
// orchestrator state; skip edits the roadmap file; edit-plan opens the authoring
// editor) — never an imperative side-channel.

import React from 'react'

import { GhostButton, InlineNotice, LifecycleGlyph, PrimaryButton, type LifecycleState } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import type {
  RoadmapBoardLane,
  RoadmapBoardUnit,
  RoadmapBoardUnitChild,
  RoadmapUnitState,
} from '../../../../../shared/sprintengine/roadmap-surface'
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
  showProjectTag = false,
  readOnly = false,
}: {
  lane: RoadmapBoardLane
  folderPath: string | null
  callbacks: RoadmapLaneCallbacks
  onReloadBoard: () => void
  /** Tag each step with the project it changes — the roadmap now spans projects,
   *  so a step names the one it lives in (mockup §2). Off for a single-project plan
   *  where the tag would be noise. */
  showProjectTag?: boolean
  /** A DRAFT's plan-at-a-glance: no steering controls, no per-step actions —
   *  nothing is orchestrated, so offering Pause/Skip would be dishonest. */
  readOnly?: boolean
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
        {readOnly ? null : <LaneControls lane={lane} busy={busy} callbacks={callbacks} />}
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
                showProjectTag={showProjectTag}
                readOnly={readOnly}
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
        <PrimaryButton size="xs" disabled={busy} onClick={() => callbacks.onResume(lane.lane)}>
          Resume
        </PrimaryButton>
      ) : lane.attention === 'approval' ? (
        <PrimaryButton size="xs" disabled={busy} onClick={() => callbacks.onApprove(lane.lane)}>
          Start next
        </PrimaryButton>
      ) : lane.attention === 'merge' ? (
        <PrimaryButton size="xs" disabled={busy} onClick={() => callbacks.onMerge(lane.lane)}>
          Approve &amp; merge
        </PrimaryButton>
      ) : (
        <GhostButton size="xs" disabled={busy} onClick={() => callbacks.onPause(lane.lane)}>
          Pause
        </GhostButton>
      )}
      {/* Secondary: editing the plan is always available. */}
      <GhostButton size="xs" disabled={busy} onClick={callbacks.onEditPlan}>
        Edit plan
      </GhostButton>
    </div>
  )
}

function RoadmapUnitRow({
  unit,
  lane,
  busy,
  showProjectTag,
  readOnly,
  onSkip,
  onOpenRun,
}: {
  unit: RoadmapBoardUnit
  lane: string
  busy: boolean
  showProjectTag: boolean
  readOnly: boolean
  onSkip: () => void
  onOpenRun?: () => void
}): JSX.Element {
  const isDone = unit.state === 'done'
  const canSkip = !readOnly && (unit.state === 'up_next' || unit.state === 'queued' || unit.state === 'unknown')
  const childrenDone = unit.children?.filter((child) => child.done).length ?? 0
  return (
    <div className="group relative flex flex-col px-3 py-1.5">
      <div className="flex items-center gap-2">
      <LifecycleGlyph state={UNIT_LIFECYCLE[unit.state]} live={unit.state === 'running'} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-[12px] ${isDone ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-default)]'}`}
            title={unit.title}
          >
            {unit.title}
          </span>
          {showProjectTag ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-[color:var(--border-subtle)] px-1 py-px font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]"
              title={
                unit.state === 'unknown_project'
                  ? `${unit.projectName} — this project is not open in this Multicode`
                  : `In ${unit.projectName}`
              }
            >
              <ProjectBranchGlyph />
              <span className="max-w-[120px] truncate">{unit.projectName}</span>
            </span>
          ) : null}
          {unit.kind === 'epic' && unit.children ? (
            <span
              className="shrink-0 text-[10px] leading-4 tabular-nums text-[color:var(--text-subtle)]"
              title={`Epic — one sprint delivers all ${unit.children.length} items in this step`}
            >
              {childrenDone}/{unit.children.length} items
            </span>
          ) : null}
          {unit.state === 'unknown' ? (
            <span className="shrink-0 text-[10px] font-medium text-[color:var(--tone-warn)]">Unknown</span>
          ) : null}
          {unit.state === 'unknown_project' ? (
            <span className="shrink-0 text-[10px] font-medium text-[color:var(--tone-warn)]">Project not found</span>
          ) : null}
        </div>
      </div>
      {/* Trailing, hover-revealed actions — kept off the row at rest, but the
          keyboard reveals them on focus (opacity, not display, so they stay
          focusable). */}
      {onOpenRun ? (
        <GhostButton
          size="xs"
          onClick={onOpenRun}
          className="shrink-0"
          aria-label={`Open the running sprint for ${unit.title}`}
        >
          Open sprint
        </GhostButton>
      ) : null}
      {unit.prUrl && isDone ? (
        <a
          href={unit.prUrl}
          target="_blank"
          rel="noreferrer"
          className={`interactive inline-flex h-6 shrink-0 items-center rounded-[5px] px-2 text-[11px] font-medium text-[color:var(--accent-primary)] opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover:opacity-100 ${FOCUS_RING_CLASS}`}
          aria-label={`View the pull request for ${unit.title}`}
        >
          PR
        </a>
      ) : null}
      {canSkip ? (
        <GhostButton
          size="xs"
          disabled={busy}
          onClick={onSkip}
          aria-label={`Skip ${unit.title} in ${lane}`}
          className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          Skip
        </GhostButton>
      ) : null}
      </div>
      {unit.children && unit.children.length > 0 ? (
        <ul className="ml-[1.35rem] mt-0.5 flex flex-col gap-0.5 border-l border-[color:var(--border-subtle)] pl-2">
          {unit.children.map((child, index) => (
            <li key={`${child.ref}:${index}`} className="flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
              <LifecycleGlyph state={childLifecycle(child)} />
              <span className="min-w-0 truncate" title={child.title}>
                {child.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// A snapshotted epic member's glyph state, from its live backlog status. The
// members of a step ride ONE sprint, so this is item-status truth, not run state.
function childLifecycle(child: RoadmapBoardUnitChild): LifecycleState {
  if (child.done) return 'done'
  switch (child.status) {
    case 'in_progress':
      return 'in_progress'
    case 'needs_input':
      return 'blocked'
    case 'ready':
      return 'ready'
    default:
      return 'todo'
  }
}

// The project tag's leading glyph — a small branch mark, matching the design's
// "this step changes <project>" idiom without pulling in an icon set.
function ProjectBranchGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5 shrink-0 text-[color:var(--text-disabled)]" aria-hidden="true">
      <circle cx="4" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="6" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5.8 V10.2 M12 7.8 C12 10 9 10.5 6 10.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
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
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2">
        <InlineNotice
          tone="error"
          title="Couldn’t load this sprint’s pull requests."
          hint="This is usually temporary."
          detail={error}
          action={
            <GhostButton size="xs" onClick={reload}>
              Try again
            </GhostButton>
          }
        />
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
