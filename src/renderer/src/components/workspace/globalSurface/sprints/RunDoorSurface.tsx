import { useCallback, useEffect, useMemo, useState } from 'react'

import { normalizeStatePathKey } from '../../../../store/sprintRunStoreSlice'
import { EmptyState, PrimaryButton } from '../../../ui'
import { GlobalSurfaceShell } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  buildSprintRailRows,
  sprintRunMatchesSearch,
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
import { WorkflowsGlyph } from '../../surfaceGlyphs'
import { runsForDoor, type RunDoorId } from './runDoors'
import type { RunDoorDefinition } from './runDoorCopy'
import { useSprintRunIndex } from './useSprintRunIndex'

// The door-routed full-page surface both run doors are (item 1763, mockup §1
// and §2; two doors since item 2470).
//
// A run has always been able to span projects — it just lived as a workspace row
// nested under one of them, so the UI claimed it belonged there, and a run whose
// workspace was closed vanished. This is where runs live now: a rail of every run
// in this studio, live and historical, filterable by project, over a canvas.
//
// The canvas is the selected run in full (item 1764): the repositories it
// declares, its rollup, and its board — mounted by run identity, so a run whose
// workspace is gone opens like any other.
//
// ONE SURFACE, TWO DOORS. Item 2470 split the noun in two — Workflows for the
// runs that turn a goal into a plan, Sprints for the runs that work a plan that
// already exists — and this file is what both of them are. Only two things
// differ, and both are data: which runs the door lists (`runDoors.ts`, the run
// partition) and the words it uses (`runDoorCopy.ts`). Nothing about the board,
// the graph, the roster view or the inspector changes with the door, because a
// workflow's board and a sprint's board are the same board and the only
// difference is who decided what was on it (owner ruling R7).
//
// The alternative was a second surface beside this one, and the three door
// surfaces this substrate was built to un-fork are what that becomes.

// The rail selection survives closing the door: reopening returns you to the run
// you were reading, not to the top of the list. Per DOOR, because the two lists
// are disjoint — a workflow can never be the Sprints door's last selection.
// Module-scoped rather than persisted: this is view state for the life of the
// window, like the door's own open/closed flag (epic-1705 rule).
const lastSelectedStatePath: Record<RunDoorId, string | null> = { workflows: null, sprints: null }

// What the rail opens on: the run someone handed the door if there is one — a run
// just created here (item 1765) or a Backlog run link jumping in (item 1767) —
// else wherever the operator last was in THIS door. The index is re-read on every
// mount, so a run created moments ago is already listed by the time the rows
// resolve. The handover latch is shared by both doors and only one door is ever
// mounted, so consuming it here lands the run in whichever door was opened —
// which is the door the link resolved the run to.
function initialSelectedStatePath(door: RunDoorId): string | null {
  const handedOver = consumeSprintDoorSelection()
  if (handedOver) lastSelectedStatePath[door] = handedOver
  return lastSelectedStatePath[door]
}

export function RunDoorSurface({ door }: { door: RunDoorDefinition }): JSX.Element {
  const back = useSurfaceBackNav()
  const { runs: everyRun, loadState, error, reload } = useSprintRunIndex()

  // The door's own runs. One read of the index, partitioned — every run in this
  // studio belongs to exactly one door, so no run appears in both and none
  // appears in neither (see `runDoors.ts` for what an unclassifiable run does).
  const runs = useMemo(() => runsForDoor(everyRun, door.id), [everyRun, door.id])

  const [selectedStatePath, setSelectedStatePath] = useState<string | null>(() =>
    initialSelectedStatePath(door.id),
  )
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

  const select = useCallback(
    (statePath: string) => {
      lastSelectedStatePath[door.id] = statePath
      setSelectedStatePath(statePath)
    },
    [door.id],
  )

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
      lastSelectedStatePath[door.id] = null
      setSelectedStatePath(null)
    },
    [runs, selectedKey, door.id],
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
    lastSelectedStatePath[door.id] = next.id
    setSelectedStatePath(next.id)
  }, [loadState, rows, selectedKey, selectedStatePath, door.id])

  // The selected run in full: its projection, its repositories, its merge state —
  // and, for a run only this door is watching, its single refresh driver.
  const canvas = useSprintRunCanvas(selectedRun)

  // A run whose store was just deleted (item 1767) is gone, not merely closed:
  // drop the selection before re-reading the index, so the canvas never spends a
  // frame on a run that is no longer on disk. The open-on-content effect above
  // then lands on whatever the rail leads with.
  const handleRunDeleted = useCallback(() => {
    lastSelectedStatePath[door.id] = null
    setSelectedStatePath(null)
    reload()
  }, [reload, door.id])

  // The run's name and its controls. The state chip and the "project · N tasks ·
  // started <date>" line both moved out: the canvas under this bar opens with the
  // run's own status line and its task counts, and the rail row for this run
  // carries its state glyph — the bar was the third place to read the same thing.
  const bar = useMemo(() => {
    if (!selectedRun) return { title: door.label }
    return {
      title: selectedRun.teamName,
      actions: canvas ? <SprintsBarActions model={canvas} onRunDeleted={handleRunDeleted} /> : undefined,
    }
  }, [selectedRun, canvas, handleRunDeleted, door.label])

  const rail = (
    <SprintsRail
      door={door}
      runs={runs}
      selectedStatePath={selectedStatePath}
      projectFilter={projectFilter}
      search={search}
      sort={sort}
      onSelect={select}
      onFilter={filter}
      onSearch={setSearch}
      onSort={setSort}
      onCreate={() => requestNewSprint(undefined, door.id)}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel={door.label}
      bar={bar}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      // The rail is DECLARED, not derived from what the door happens to hold
      // (T19): it is present in every load state, so opening the door replaces
      // the projects rail immediately rather than once there is a run in it.
      // Gating it on `runs.length > 0` meant a first-run or still-loading door
      // kept the projects sidebar beside its own canvas — two navigation
      // columns, which item 1993 forbids outright. Loading, empty and error are
      // the canvas's to say, beside a rail that still carries New and the lens.
      // No "Waiting on you" strip (MC-1838): the rail's "Needs you" group IS
      // where waiting runs surface, with honest since-dates — a stale run never
      // pins a permanent block above the page.
      rail={rail}
    >
      <SurfaceBody
        door={door}
        loadState={loadState}
        error={error}
        onRetry={reload}
        hasRuns={runs.length > 0}
        // Runs exist, but the chosen project holds none of them. Distinct from
        // "no runs at all" — the canvas must not offer a first-run welcome to
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
  door,
  loadState,
  error,
  onRetry,
  hasRuns,
  filteredOut,
  canvas,
}: {
  door: RunDoorDefinition
  loadState: 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  hasRuns: boolean
  filteredOut: boolean
  canvas: SprintRunCanvasModel | null
}): JSX.Element {
  if (loadState === 'loading') {
    return <SurfaceCanvasState kind="loading" label={door.loadingLabel} />
  }
  if (loadState === 'error') {
    return (
      <SurfaceCanvasState
        kind="error"
        title={door.indexError.title}
        hint={door.indexError.hint}
        detail={error ?? undefined}
        onRetry={onRetry}
      />
    )
  }
  if (!hasRuns) {
    return (
      <SurfaceCanvasState
        kind="empty"
        firstRun
        glyph={<RunDoorGlyph door={door.id} />}
        title={door.firstRun.title}
        body={door.firstRun.body}
        action={<PrimaryButton onClick={() => requestNewSprint(undefined, door.id)}>{door.newLabel}</PrimaryButton>}
      />
    )
  }
  if (canvas) return <SprintsCanvas model={{ ...canvas, noun: door.noun }} />
  // Runs exist but none is showing. Name which of the two reasons it is, so the
  // canvas never asks for a selection the rail cannot offer — in the quiet kit
  // state, never a bare line of copy in a dialect of its own.
  return (
    <EmptyState
      density="pane"
      glyph={<RunDoorGlyph door={door.id} />}
      title={filteredOut ? door.filteredOutTitle : door.selectPromptTitle}
    />
  )
}

// The doors' canvas marks, in the icon family's 16-box round-stroke idiom.
// Sprints is the four-pane board from the mockup's sidebar row; Workflows is one
// goal fanning out into the work it becomes, which is the difference between
// them said as a picture.
//
// The Workflows mark is the drawer row's own `WorkflowsGlyph`, at canvas size —
// not a second copy of it. A door and its empty state are the same door, and a
// change whose thesis is "one surface, no copies" cannot keep two identical
// path definitions to be edited apart. Sprints keeps its markup here because
// this is where the mark was moved to when the canvas took it over.
function RunDoorGlyph({ door }: { door: RunDoorId }): JSX.Element {
  if (door === 'workflows') return <WorkflowsGlyph className="size-icon-md" />
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-icon-md" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
