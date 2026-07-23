import { useCallback, useMemo, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { PrimaryButton } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { BarStatusChip, SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  sprintRunShortDate,
  sprintRunStatusLabel,
  sprintRunTone,
  RUN_INDEX_ERROR_HINT,
  RUN_INDEX_ERROR_TITLE,
} from './railState'
import { requestNewSprint } from './sprintCreationRequest'
import { SprintsRail } from './SprintsRail'
import { useSprintRunIndex } from './useSprintRunIndex'

// The Sprints tenant of the door-routed full-page surface (item 1763, mockup §1
// and §2). A sprint has always been able to span projects — it just lived as a
// workspace row nested under one of them, so the UI claimed it belonged there,
// and a run whose workspace was closed vanished. This is where runs live now: a
// rail of every run in this Multicode, live and historical, filterable by
// project, over a canvas.
//
// This ships the shell. The canvas here is the selected run's summary — enough to
// answer "where is this run?" without opening it; item 1764 replaces it with the
// multi-repo canvas, waiting-on-you strip, and board.

// The rail selection survives closing the door: reopening Sprints returns you to
// the run you were reading, not to the top of the list. Module-scoped rather than
// persisted — this is view state for the life of the window, like the door's own
// open/closed flag (epic-1705 rule).
let lastSelectedStatePath: string | null = null

export default function SprintsGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const { runs, loadState, error, reload } = useSprintRunIndex()

  const [selectedStatePath, setSelectedStatePath] = useState<string | null>(lastSelectedStatePath)
  // Which project the rail is narrowed to. Transient per-window view state — not
  // persisted and not synced across windows, so one window's lens never moves
  // another's (D7).
  const [projectFilter, setProjectFilter] = useState<string | null>(null)

  const selectedRun = useMemo(
    () => runs.find((summary) => summary.statePath === selectedStatePath) ?? null,
    [runs, selectedStatePath],
  )

  const select = useCallback((statePath: string) => {
    lastSelectedStatePath = statePath
    setSelectedStatePath(statePath)
  }, [])

  // A filter that would hide the selected run clears the selection rather than
  // leaving the canvas showing a run the rail no longer lists.
  const filter = useCallback((projectRoot: string | null) => {
    setProjectFilter(projectRoot)
    setSelectedStatePath((current) => {
      if (!projectRoot || current === null) return current
      const stillListed = runs.some(
        (summary) => summary.statePath === current && summary.projectRoot === projectRoot,
      )
      if (stillListed) return current
      lastSelectedStatePath = null
      return null
    })
  }, [runs])

  const bar = useMemo(() => {
    if (!selectedRun) return { title: 'Sprints' }
    return {
      title: selectedRun.teamName,
      statusChip: (
        <BarStatusChip
          tone={sprintRunTone(selectedRun.runtimeState)}
          label={sprintRunStatusLabel(selectedRun.runtimeState)}
          pulse={selectedRun.runtimeState === 'running'}
        />
      ),
      contextSub: runContextLine(selectedRun),
    }
  }, [selectedRun])

  const rail = (
    <SprintsRail
      runs={runs}
      selectedStatePath={selectedStatePath}
      projectFilter={projectFilter}
      onSelect={select}
      onFilter={filter}
      onCreate={requestNewSprint}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Sprints"
      bar={bar}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      // The rail is present whenever there is something to navigate — and always
      // on an error, so a failed read is never a dead end (T20). Only the first
      // load and the zero state own the canvas alone.
      rail={loadState === 'error' || (loadState === 'ready' && runs.length > 0) ? rail : undefined}
    >
      <SurfaceBody
        loadState={loadState}
        error={error}
        onRetry={reload}
        hasRuns={runs.length > 0}
        selectedRun={selectedRun}
      />
    </GlobalSurfaceShell>
  )
}

// The canvas: the three shared states (SurfaceCanvasState) plus the selected
// run's summary. Split out so the surface's return stays readable.
function SurfaceBody({
  loadState,
  error,
  onRetry,
  hasRuns,
  selectedRun,
}: {
  loadState: 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  hasRuns: boolean
  selectedRun: SprintRunSummary | null
}): JSX.Element {
  if (loadState === 'loading') {
    return <SurfaceCanvasState kind="loading" label="Loading your sprints…" />
  }
  if (loadState === 'error') {
    return (
      <SurfaceCanvasState
        kind="error"
        title={RUN_INDEX_ERROR_TITLE}
        hint={RUN_INDEX_ERROR_HINT}
        detail={error ?? undefined}
        onRetry={onRetry}
      />
    )
  }
  if (!hasRuns) {
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph={<SprintsGlyph />}
        title="Run your first sprint"
        body="A sprint puts a team of agents on a goal — planning it, working it in a branch, and reviewing the result. Runs from every project list here."
        action={<PrimaryButton onClick={requestNewSprint}>New sprint</PrimaryButton>}
      />
    )
  }
  if (selectedRun) return <RunSummaryCanvas run={selectedRun} />
  // Runs exist, none picked. A prompt, never a blank canvas.
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[color:var(--text-muted)]">
      Select a sprint to see where it stands.
    </div>
  )
}

// The interim canvas (item 1764 replaces it): where the selected run stands, read
// straight off the run index. Every line is a fact from the summary — nothing here
// needs the run's workspace to be open, which is the point of the door.
function RunSummaryCanvas({ run }: { run: SprintRunSummary }): JSX.Element {
  const started = sprintRunShortDate(run.startedAt)
  const updated = sprintRunShortDate(run.updatedAt)
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="max-w-2xl rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-4 py-3">
        <h3 className="pb-1.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">Run</h3>
        <dl className="flex flex-col">
          {run.runtimeState === 'unknown' ? (
            <SummaryRow
              label="State"
              value={run.unknownReason ?? 'This run’s details could not be read.'}
            />
          ) : (
            <>
              <SummaryRow
                label="Tasks"
                value={
                  run.taskCounts.total === 0
                    ? 'No tasks planned yet'
                    : `${run.taskCounts.done} done · ${run.taskCounts.inProgress} in progress · ${run.taskCounts.waiting} waiting`
                }
              />
              <SummaryRow label="Repositories" value={repositoriesLine(run)} />
              {run.needsInputCount > 0 ? (
                <SummaryRow
                  label="Waiting on you"
                  value={`${run.needsInputCount} ${run.needsInputCount === 1 ? 'task needs' : 'tasks need'} an answer`}
                />
              ) : null}
              {run.sourceLabel ? <SummaryRow label="Started from" value={run.sourceLabel} /> : null}
            </>
          )}
          <SummaryRow label="Project" value={run.projectName} detail={run.projectRoot} />
          {started ? <SummaryRow label="Started" value={started} /> : null}
          {updated ? <SummaryRow label="Last update" value={updated} /> : null}
        </dl>
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-3 border-b border-[color:var(--border-subtle)] py-2 last:border-b-0">
      <dt className="w-[104px] shrink-0 text-[11px] text-[color:var(--text-subtle)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12px] text-[color:var(--text-default)]">
        <span className="tabular-nums">{value}</span>
        {detail ? (
          <span className="ml-2 truncate font-mono text-[10.5px] text-[color:var(--text-subtle)]">{detail}</span>
        ) : null}
      </dd>
    </div>
  )
}

// "3 repositories · 2 merged, 1 open" — the cross-repo rollup the run declares.
// A run with no branch to merge says so rather than showing three zeros.
function repositoriesLine(run: SprintRunSummary): string {
  const { declared, merged, open } = run.repoRollup
  if (declared === 0) return 'Nothing to merge'
  const label = declared === 1 ? '1 repository' : `${declared} repositories`
  return `${label} · ${merged} merged, ${open} open`
}

// The bar's context line: which project(s), how much work, and when it started.
function runContextLine(run: SprintRunSummary): string {
  const parts: string[] = []
  const siblings = run.repoRollup.declared - 1
  parts.push(siblings >= 1 ? `${run.projectName} +${siblings} ${siblings === 1 ? 'repo' : 'repos'}` : run.projectName)
  if (run.taskCounts.total > 0) {
    parts.push(`${run.taskCounts.total} ${run.taskCounts.total === 1 ? 'task' : 'tasks'}`)
  }
  const started = sprintRunShortDate(run.startedAt)
  if (started) parts.push(`started ${started}`)
  return parts.join(' · ')
}

// The Sprints glyph — the four-pane board mark from the mockup's sidebar row, in
// the icon family's 16-box round-stroke idiom.
function SprintsGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
