import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { PrimaryButton, Section } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { BarStatusChip, SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  buildSprintRailRows,
  sprintRunProjectPhrase,
  sprintRunShortDate,
  sprintRunStatusLabel,
  sprintRunTone,
  RUN_INDEX_ERROR_HINT,
  RUN_INDEX_ERROR_TITLE,
} from './railState'
import { consumeSprintCreatedFromDoor, requestNewSprint } from './sprintCreationRequest'
import {
  SprintsBarActions,
  SprintsCanvas,
  useSprintRunCanvas,
  type SprintRunCanvasModel,
} from './SprintsCanvas'
import { SprintsRail } from './SprintsRail'
import { collectSprintWaitingRows, SprintsWaitingStrip } from './SprintsWaitingStrip'
import { useSprintRunIndex } from './useSprintRunIndex'

// The Sprints tenant of the door-routed full-page surface (item 1763, mockup §1
// and §2). A sprint has always been able to span projects — it just lived as a
// workspace row nested under one of them, so the UI claimed it belonged there,
// and a run whose workspace was closed vanished. This is where runs live now: a
// rail of every run in this Multicode, live and historical, filterable by
// project, over a canvas.
//
// The canvas is the selected run in full (item 1764): the repositories it
// declares, its rollup, and its board — mounted by run identity, so a run whose
// workspace is gone opens like any other. Above them, "Waiting on you" aggregates
// across EVERY run, because the run that needs you is rarely the one you are
// reading.

// The rail selection survives closing the door: reopening Sprints returns you to
// the run you were reading, not to the top of the list. Module-scoped rather than
// persisted — this is view state for the life of the window, like the door's own
// open/closed flag (epic-1705 rule).
let lastSelectedStatePath: string | null = null

// What the rail opens on: the run just created from this door if there is one
// (item 1765 — creating a sprint here comes back here, on the new run), else
// wherever the operator last was. The index is re-read on every mount, so a run
// created moments ago is already listed by the time the rows resolve.
function initialSelectedStatePath(): string | null {
  const created = consumeSprintCreatedFromDoor()
  if (created) lastSelectedStatePath = created
  return lastSelectedStatePath
}

export default function SprintsGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const { runs, loadState, error, reload } = useSprintRunIndex()

  const [selectedStatePath, setSelectedStatePath] = useState<string | null>(initialSelectedStatePath)
  // Which project the rail is narrowed to. Transient per-window view state — not
  // persisted and not synced across windows, so one window's lens never moves
  // another's (D7).
  const [projectFilter, setProjectFilter] = useState<string | null>(null)

  const selectedRun = useMemo(
    () => runs.find((summary) => summary.statePath === selectedStatePath) ?? null,
    [runs, selectedStatePath],
  )

  // The rows the rail is actually showing — the same ordering and filtering it
  // draws, so "the first row" means the same thing to both of us.
  const rows = useMemo(() => buildSprintRailRows(runs, projectFilter), [runs, projectFilter])

  const select = useCallback((statePath: string) => {
    lastSelectedStatePath = statePath
    setSelectedStatePath(statePath)
  }, [])

  // A filter that would hide the selected run clears the selection rather than
  // leaving the canvas showing a run the rail no longer lists.
  const filter = useCallback(
    (projectRoot: string | null) => {
      setProjectFilter(projectRoot)
      if (!projectRoot || selectedStatePath === null) return
      const stillListed = runs.some(
        (summary) => summary.statePath === selectedStatePath && summary.projectRoot === projectRoot,
      )
      if (stillListed) return
      lastSelectedStatePath = null
      setSelectedStatePath(null)
    },
    [runs, selectedStatePath],
  )

  // Open on content, not on a prompt: with no restored selection (or one whose
  // run is gone — a deleted run store), fall to the row the rail leads with,
  // which the attention ordering makes the run most worth looking at.
  useEffect(() => {
    if (loadState !== 'ready' || rows.length === 0) return
    if (selectedStatePath && rows.some((row) => row.id === selectedStatePath)) return
    const first = rows[0]
    if (!first) return
    lastSelectedStatePath = first.id
    setSelectedStatePath(first.id)
  }, [loadState, rows, selectedStatePath])

  // The selected run in full: its projection, its repositories, its merge state —
  // and, for a run only this door is watching, its single refresh driver.
  const canvas = useSprintRunCanvas(selectedRun)

  // Everything waiting on the operator, across every run in the index — not only
  // the selected one. Rows jump the rail, so the strip stays a summary.
  const waitingRows = useMemo(() => collectSprintWaitingRows(runs), [runs])

  const bar = useMemo(() => {
    if (!selectedRun) return { title: 'Sprints' }
    return {
      title: selectedRun.teamName,
      statusChip: (
        <BarStatusChip
          tone={canvas?.landed ? 'merged' : sprintRunTone(selectedRun.runtimeState)}
          // Landed is the multi-repo truth (D10): a completed run whose branches
          // have not all merged still reads "Completed", never "Landed".
          label={canvas?.landed ? 'Landed' : sprintRunStatusLabel(selectedRun.runtimeState)}
          pulse={selectedRun.runtimeState === 'running'}
        />
      ),
      contextSub: runContextLine(selectedRun),
      actions: canvas ? <SprintsBarActions model={canvas} /> : undefined,
    }
  }, [selectedRun, canvas])

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
      attention={
        waitingRows.length > 0 ? (
          <Section title="Waiting on you" count={waitingRows.length} level={3} inset={false}>
            <SprintsWaitingStrip
              rows={waitingRows}
              selectedStatePath={selectedStatePath}
              onSelect={select}
            />
          </Section>
        ) : undefined
      }
    >
      <SurfaceBody
        loadState={loadState}
        error={error}
        onRetry={reload}
        hasRuns={runs.length > 0}
        // Runs exist, but the chosen project holds none of them. Distinct from
        // "no sprints at all" — the canvas must not offer a first-run welcome to
        // someone who simply picked a quiet project.
        filteredOut={runs.length > 0 && rows.length === 0}
        canvas={canvas}
      />
    </GlobalSurfaceShell>
  )
}

// The canvas: the three shared states (SurfaceCanvasState) for the INDEX, then
// the selected run's own canvas (which owns its own degraded states for the run's
// projection). Split out so the surface's return stays readable.
function SurfaceBody({
  loadState,
  error,
  onRetry,
  hasRuns,
  filteredOut,
  canvas,
}: {
  loadState: 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  hasRuns: boolean
  filteredOut: boolean
  canvas: SprintRunCanvasModel | null
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
  if (canvas) return <SprintsCanvas model={canvas} />
  // Runs exist but none is showing. Name which of the two reasons it is, so the
  // canvas never asks for a selection the rail cannot offer.
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[color:var(--text-muted)]">
      {filteredOut
        ? 'No sprints in this project. Pick another project, or All projects, to see the rest.'
        : 'Select a sprint to see where it stands.'}
    </div>
  )
}

// The bar's context line: which project(s), how much work, and when it started.
// The repo span reuses the rail's phrase, so bar and rail never describe the same
// run's span differently.
function runContextLine(run: SprintRunSummary): string {
  const parts: string[] = [sprintRunProjectPhrase(run)]
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
