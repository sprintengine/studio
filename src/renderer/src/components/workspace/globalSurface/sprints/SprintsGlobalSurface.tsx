import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { normalizeStatePathKey } from '../../../../store/sprintRunStoreSlice'
import { PrimaryButton } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { BarStatusChip, SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  buildSprintRailRows,
  sprintRunMatchesSearch,
  sprintRunProjectPhrase,
  sprintRunShortDate,
  sprintRunStatusLabel,
  sprintRunTone,
  RUN_INDEX_ERROR_HINT,
  RUN_INDEX_ERROR_TITLE,
  type SprintSort,
} from './railState'
import { consumeSprintDoorSelection, requestNewSprint } from './sprintDoorRequests'
import {
  SprintsBarActions,
  SprintsCanvas,
  useSprintRunCanvas,
  type SprintRunCanvasModel,
} from './SprintsCanvas'
import { SprintsRail } from './SprintsRail'
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

// What the rail opens on: the run someone handed the door if there is one — a
// sprint just created here (item 1765) or a Backlog run link jumping in (item
// 1767) — else wherever the operator last was. The index is re-read on every
// mount, so a run created moments ago is already listed by the time the rows
// resolve.
function initialSelectedStatePath(): string | null {
  const handedOver = consumeSprintDoorSelection()
  if (handedOver) lastSelectedStatePath = handedOver
  return lastSelectedStatePath
}

export default function SprintsGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const { runs, loadState, error, reload } = useSprintRunIndex()

  const [selectedStatePath, setSelectedStatePath] = useState<string | null>(initialSelectedStatePath)
  // Which project the rail is narrowed to, and the rail's search query. Transient
  // per-window view state — not persisted and not synced across windows, so one
  // window's lens never moves another's (D7).
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SprintSort>('recent')

  // One run can be spelled two ways: the index builds native-separator paths
  // with `path.join`, while a Backlog "Open Sprint" link builds forward-slash
  // ones (item 1803). Every match below is therefore made on the normalized key
  // — raw equality drops the link on Windows and silently opens another run.
  const selectedKey = selectedStatePath === null ? null : normalizeStatePathKey(selectedStatePath)

  const selectedRun = useMemo(
    () => runs.find((summary) => normalizeStatePathKey(summary.statePath) === selectedKey) ?? null,
    [runs, selectedKey],
  )

  // The rows the rail could show under the current filter/search. Deliberately
  // the attention-first 'status' order regardless of the rail's sort: falling to
  // "the first row" should land on the run most worth looking at (needs-input
  // first), not merely the most recently touched.
  const rows = useMemo(
    () =>
      buildSprintRailRows(
        runs.filter((summary) => sprintRunMatchesSearch(summary, search)),
        projectFilter,
        'status',
      ),
    [runs, projectFilter, search],
  )

  const select = useCallback((statePath: string) => {
    lastSelectedStatePath = statePath
    setSelectedStatePath(statePath)
  }, [])

  // A filter that would hide the selected run clears the selection rather than
  // leaving the canvas showing a run the rail no longer lists.
  const filter = useCallback(
    (projectRoot: string | null) => {
      setProjectFilter(projectRoot)
      if (!projectRoot || selectedKey === null) return
      const stillListed = runs.some(
        (summary) =>
          normalizeStatePathKey(summary.statePath) === selectedKey && summary.projectRoot === projectRoot,
      )
      if (stillListed) return
      lastSelectedStatePath = null
      setSelectedStatePath(null)
    },
    [runs, selectedKey],
  )

  // Open on content, not on a prompt: with no restored selection (or one whose
  // run is gone — a deleted run store), fall to the row the rail leads with,
  // which the attention ordering makes the run most worth looking at.
  //
  // A resolved row also lends the selection its own spelling of the statePath,
  // so a handed-over link path is adopted once and everything downstream (the
  // rail's selected-row marker, the canvas) keeps comparing by identity.
  useEffect(() => {
    if (loadState !== 'ready' || rows.length === 0) return
    const matched = rows.find((row) => normalizeStatePathKey(row.id) === selectedKey)
    if (matched?.id === selectedStatePath) return
    const next = matched ?? rows[0]
    if (!next) return
    lastSelectedStatePath = next.id
    setSelectedStatePath(next.id)
  }, [loadState, rows, selectedKey, selectedStatePath])

  // The selected run in full: its projection, its repositories, its merge state —
  // and, for a run only this door is watching, its single refresh driver.
  const canvas = useSprintRunCanvas(selectedRun)

  // A run whose store was just deleted (item 1767) is gone, not merely closed:
  // drop the selection before re-reading the index, so the canvas never spends a
  // frame on a run that is no longer on disk. The open-on-content effect above
  // then lands on whatever the rail leads with.
  const handleRunDeleted = useCallback(() => {
    lastSelectedStatePath = null
    setSelectedStatePath(null)
    reload()
  }, [reload])

  const bar = useMemo(() => {
    if (!selectedRun) return { title: 'Sprints' }
    // The canvas reads the run's LIVE projection; the index summary is a cached
    // snapshot that only refreshes on a runs-changed event. When they disagree
    // (a cancel/completion the index has not heard about yet), the projection
    // wins — the chip must never keep pulsing "Running" on a canceled run.
    const runtimeState = canvas?.canceled
      ? 'canceled'
      : canvas?.completed
        ? 'completed'
        : selectedRun.runtimeState
    return {
      title: selectedRun.teamName,
      statusChip: (
        <BarStatusChip
          tone={canvas?.landed ? 'merged' : sprintRunTone(runtimeState)}
          // Landed is the multi-repo truth (D10): a completed run whose branches
          // have not all merged still reads "Completed", never "Landed".
          label={canvas?.landed ? 'Landed' : sprintRunStatusLabel(runtimeState)}
          pulse={runtimeState === 'running'}
        />
      ),
      contextSub: runContextLine(selectedRun),
      actions: canvas ? <SprintsBarActions model={canvas} onRunDeleted={handleRunDeleted} /> : undefined,
    }
  }, [selectedRun, canvas, handleRunDeleted])

  const rail = (
    <SprintsRail
      runs={runs}
      selectedStatePath={selectedStatePath}
      projectFilter={projectFilter}
      search={search}
      sort={sort}
      onSelect={select}
      onFilter={filter}
      onSearch={setSearch}
      onSort={setSort}
      onCreate={requestNewSprint}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Sprints"
      bar={bar}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      // The rail is DECLARED, not derived from what the door happens to hold
      // (T19): it is present in every load state, so opening the door replaces
      // the projects rail immediately rather than once there is a run in it.
      // Gating it on `runs.length > 0` meant a first-run or still-loading Sprints
      // door kept the projects sidebar beside its own canvas — two navigation
      // columns, which item 1993 forbids outright. Loading, empty and error are
      // the canvas's to say, beside a rail that still carries New and the lens.
      // No "Waiting on you" strip (MC-1838): the rail's "Needs you" group IS
      // where waiting runs surface, with honest since-dates — a stale sprint
      // never pins a permanent block above the page.
      rail={rail}
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
        ? 'No sprints match. Clear the search or pick All projects to see the rest.'
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
