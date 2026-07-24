// The Roadmap tenant of the door-routed full-page surface (global-surfaces epic
// 1704, mockup §2). Registered by the roadmap module and mounted by
// WorkspaceManager over the workspace card region when the Roadmap door opens —
// no scrim, no 1080×760 card, no Escape trap: this is a page, not a dialog.
//
// Anatomy: a roadmaps RAIL (every roadmap file in this Multicode, exactly one
// Active, the rest drafts, plus "New roadmap"), a surface BAR (name · Active/Draft
// · "N tracks · M steps · K running" · merge policy · Edit plan · Pause), the
// waiting-on-you ATTENTION strip, and a full-width CANVAS of the selected
// roadmap's tracks. The one-active-roadmap rule (epic 1687 D1) gets its visible
// home here — extra roadmap files surface as drafts, and activating one is an
// explicit action, never a silent newest-id pick.
//
// The board/planner/orchestrator/substrate underneath carry over unchanged: every
// steering control is a file/store write the orchestrator reconciles against, and
// the roadmap file (its home in the D1 home project) is the source of truth. The
// board leaves by activating a workspace, which clears the active surface.

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { RoadmapBoardUnit } from '../../../../../shared/sprintengine/roadmap-surface'
import { buildRoadmapRail, roadmapProgress } from '../../../../../shared/sprintengine/roadmap-surface'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { GhostButton, InlineNotice, PrimaryButton, Section, Spinner, useConfirmDialog } from '../../ui'
import { normalizeRelativePath } from '../../../utils/backlog'
import { basename, samePath } from '../../../utils/paths'
import { revealNavRailComponent } from '../../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../../utils/backlogReveal'
import { BarStatusChip, SurfaceCanvasState } from './surfaceSubstrate'
import { useSurfaceBackNav } from './surfaceBackNav'
import {
  ACTIVE_ROADMAP_STATUSES,
  useRoadmapBoard,
  type LoadedRoadmap,
  type RoadmapFileSummary,
} from '../../panels/roadmapBoard/roadmapBoardData'
import { RoadmapLaneColumn, type RoadmapLaneCallbacks } from '../../panels/roadmapBoard/RoadmapLaneColumn'
import { RoadmapPlannerView } from '../../panels/roadmapBoard/RoadmapPlannerView'
import { RoadmapWaitingOnYou, collectRoadmapInbox } from '../../panels/roadmapBoard/RoadmapWaitingOnYou'
import { RoadmapRail, type RoadmapRailRow } from '../../panels/roadmapBoard/RoadmapRail'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from './GlobalSurfaceShell'

export default function RoadmapGlobalSurface(): JSX.Element {
  const { roadmaps, roadmapFiles, activeRef, loading, refreshing, error, homePath, reload } = useRoadmapBoard()
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const projectCount = useWorkspaceStore(
    useShallow((s) => {
      const roots = new Set<string>()
      for (const w of s.workspaces) {
        if (w.folderPath) roots.add(w.folderPath.toLowerCase())
      }
      return roots.size
    }),
  )
  const dialog = useConfirmDialog()
  const [busyLane, setBusyLane] = useState<string | null>(null)
  const [busyBoard, setBusyBoard] = useState(false)
  const [creating, setCreating] = useState(false)
  const [activating, setActivating] = useState(false)
  // A steering command (approve/merge/pause/skip/create/activate) that fails is a
  // non-blocking error card at the top of the canvas, never a confirm-as-alert
  // dialog that hijacks the surface (T20 / mockup: failures never block).
  const [actionError, setActionError] = useState<string | null>(null)
  const back = useSurfaceBackNav()
  // The roadmap file being planned in the in-surface cross-project planner, or
  // null when the steering board is showing. Planning happens here — no detour to
  // a single project's Backlog panel.
  const [planningRef, setPlanningRef] = useState<string | null>(null)
  // Which rail roadmap the canvas shows. Null falls back to the active roadmap.
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  // The rail's search query — transient per-window view state.
  const [railSearch, setRailSearch] = useState('')
  const laneRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

  const runLaneCommand = useCallback(
    async (lane: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
      setBusyLane(lane)
      try {
        const result = await action()
        if (!result.ok && result.message) setActionError(result.message)
      } finally {
        setBusyLane(null)
        reload()
      }
    },
    [reload],
  )

  // Roadmap-level pause/resume (mockup §2 surface bar): loops the SAME per-lane
  // command over every track once, so it is a convenience over the existing
  // controls — never a new orchestrator primitive. Stops on the first failure and
  // surfaces it, then reloads once.
  const runBoardCommand = useCallback(
    async (lanes: ReadonlyArray<string>, action: (lane: string) => Promise<{ ok: boolean; message?: string }>) => {
      setBusyBoard(true)
      try {
        for (const lane of lanes) {
          const result = await action(lane)
          if (!result.ok && result.message) {
            setActionError(result.message)
            break
          }
        }
      } finally {
        setBusyBoard(false)
        reload()
      }
    },
    [reload],
  )

  const handlePauseRoadmap = useCallback(
    async (roadmap: LoadedRoadmap) => {
      const lanes = roadmap.lanes.filter((lane) => !lane.parked).map((lane) => lane.lane)
      if (lanes.length === 0) return
      const ok = await dialog.confirm({
        title: `Pause ${roadmap.title}?`,
        body: 'Every track stops starting or merging new work until you resume it. Sprints already running keep going.',
        confirmLabel: 'Pause horizon',
      })
      if (!ok) return
      await runBoardCommand(lanes, (lane) => window.api.pauseRoadmapLane({ roadmapRef: roadmap.roadmapRef, lane }))
    },
    [dialog, runBoardCommand],
  )

  const handleResumeRoadmap = useCallback(
    (roadmap: LoadedRoadmap) => {
      const lanes = roadmap.lanes.filter((lane) => lane.parked).map((lane) => lane.lane)
      if (lanes.length === 0) return
      void runBoardCommand(lanes, (lane) => window.api.resumeRoadmapLane({ roadmapRef: roadmap.roadmapRef, lane }))
    },
    [runBoardCommand],
  )

  const commandInput = useCallback((roadmapRef: string, lane: string) => ({ roadmapRef, lane }), [])

  const handleApprove = useCallback(
    (roadmapRef: string, lane: string) =>
      void runLaneCommand(lane, () => window.api.approveRoadmapLane(commandInput(roadmapRef, lane))),
    [commandInput, runLaneCommand],
  )
  const handleMerge = useCallback(
    (roadmapRef: string, lane: string) =>
      void runLaneCommand(lane, () => window.api.mergeRoadmapLane(commandInput(roadmapRef, lane))),
    [commandInput, runLaneCommand],
  )
  const handleResume = useCallback(
    (roadmapRef: string, lane: string) =>
      void runLaneCommand(lane, () => window.api.resumeRoadmapLane(commandInput(roadmapRef, lane))),
    [commandInput, runLaneCommand],
  )
  const handlePause = useCallback(
    async (roadmapRef: string, lane: string) => {
      const ok = await dialog.confirm({
        title: `Pause ${lane}?`,
        body: 'This holds the track: nothing new starts or merges automatically until you resume. A sprint already running keeps going.',
        confirmLabel: 'Pause',
      })
      if (!ok) return
      void runLaneCommand(lane, () => window.api.pauseRoadmapLane(commandInput(roadmapRef, lane)))
    },
    [commandInput, dialog, runLaneCommand],
  )

  // Skip removes the step from the active roadmap's file (the source of truth) in one
  // main-process op; the orchestrator advances past the removed step on its next
  // reconcile. Skip is only ever offered on the active roadmap's tracks, so the op
  // derives the target roadmap itself — the component carries only intent + error.
  const handleSkip = useCallback(
    async (lane: string, unit: RoadmapBoardUnit) => {
      const reason = await dialog.prompt({
        title: `Skip “${unit.title}”?`,
        body: 'This removes the step from this track so the horizon moves past it. Tell us why — it is recorded in the horizon file.',
        confirmLabel: 'Skip step',
        inputLabel: 'Reason for skipping',
        placeholder: 'e.g. superseded by another item',
        required: true,
        validate: (value) => (value.trim().length === 0 ? 'A reason is required.' : null),
      })
      if (reason === null) return
      setBusyLane(lane)
      try {
        const result = await window.api.skipRoadmapStep({ ref: unit.ref, reason: reason.trim() })
        if (!result.ok) {
          setActionError(
            result.message ??
              'This step was not found in the horizon file, so nothing changed. Refresh and try again, or open “Edit plan” to change it directly.',
          )
        }
      } finally {
        setBusyLane(null)
        reload()
      }
    },
    [dialog, reload],
  )

  // Reveal a backlog file in its project's Backlog panel. Cross-project safe: the
  // item may live in any project, so it routes to that project's workspace (which
  // clears this surface) and otherwise leaves the surface in place. Several
  // workspaces can share the project root — every sprint run mounts one — so
  // prefer a PLAIN workspace: clicking a step must open the item's detail, never
  // dump the user into whichever sprint happens to share the folder.
  const openPlanning = useCallback(
    (projectRoot: string, relativePath: string) => {
      const candidates = useWorkspaceStore
        .getState()
        .workspaces.filter((candidate) => samePath(candidate.folderPath, projectRoot))
      const workspace = candidates.find((candidate) => !candidate.sprintEngineContext) ?? candidates[0]
      if (!workspace) return
      setActiveWorkspace(workspace.id)
      revealNavRailComponent(workspace.id, 'backlog', 'Backlog')
      dispatchBacklogReveal({ workspaceId: workspace.id, relativePath })
    },
    [setActiveWorkspace],
  )

  const handleEditPlan = useCallback((roadmapRef: string) => setPlanningRef(roadmapRef), [])

  // Focus the running sprint's own workspace, when it is open. Autonomous runs may
  // not be mounted as a workspace; the affordance is then inert, never a broken link.
  const handleOpenRun = useCallback(
    (statePath: string) => {
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((candidate) => candidate.sprintEngineContext?.statePath === statePath)
      if (workspace) setActiveWorkspace(workspace.id)
    },
    [setActiveWorkspace],
  )

  const handleSelectInbox = useCallback((roadmapRef: string, lane: string) => {
    const node = laneRefs.current.get(`${roadmapRef}:${lane}`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [])

  // Create a new roadmap: pick the home project (D1), write the file (a DRAFT —
  // status idea, so nothing runs until it is made active), set the home project if
  // unset, select it, and drop into planning.
  const handleCreateRoadmap = useCallback(async () => {
    const store = useWorkspaceStore.getState()
    const active = store.workspaces.find((w) => w.id === store.activeWorkspaceId)
    const projectRoot = homePath ?? active?.folderPath ?? store.workspaces[0]?.folderPath ?? null
    if (!projectRoot) {
      setActionError('Open a project first. A horizon lines up work across your projects, so it needs at least one open.')
      return
    }
    const projectName = basename(projectRoot)
    const name = (
      await dialog.prompt({
        title: 'New horizon',
        body: homePath
          ? 'Name your horizon. It can line up work from every project in this Multicode.'
          : `Your roadmap will live in ${projectName} and can line up work from every project in this Multicode.`,
        inputLabel: 'Horizon name',
        placeholder: 'e.g. Next quarter',
        confirmLabel: 'Create',
        required: true,
        validate: (value) => (value.trim().length === 0 ? 'A name is required.' : null),
      })
    )?.trim()
    if (!name) return
    setCreating(true)
    try {
      // One main-process op writes the draft file and, when this Multicode has no home
      // project yet, adopts this one — no sequential renderer file IO to strand.
      const result = await window.api.createRoadmap({ projectRoot, name })
      if (!result.ok) {
        setActionError(result.message)
        return
      }
      reload()
      setSelectedRef(result.roadmapRef)
      setPlanningRef(result.roadmapRef)
    } finally {
      setCreating(false)
    }
  }, [dialog, homePath, reload])

  // Make a draft the single active roadmap (epic 1687 D1): one main-process op
  // promotes it to `ready` and demotes every OTHER active-status roadmap to `idea`,
  // atomically and in an order that can never strand zero active roadmaps. The
  // component keeps only the confirm-intent and error display. An explicit,
  // confirmed action — never a silent switch.
  const handleMakeActive = useCallback(
    async (file: RoadmapFileSummary) => {
      const demoting = roadmapFiles.filter(
        (candidate) => candidate.roadmapRef !== file.roadmapRef && ACTIVE_ROADMAP_STATUSES.has(candidate.status),
      )
      const ok = await dialog.confirm({
        title: `Make “${file.title}” the active horizon?`,
        body:
          demoting.length > 0
            ? `Multicode runs one horizon at a time. “${demoting[0].title}” becomes a draft — its running sprints finish, but nothing new starts on it until you make it active again.`
            : 'Multicode will start working this horizon, one sprint at a time.',
        confirmLabel: 'Make active',
      })
      if (!ok) return
      setActivating(true)
      try {
        const result = await window.api.activateRoadmap({ roadmapRef: file.roadmapRef })
        if (result.ok) {
          setSelectedRef(file.roadmapRef)
        } else {
          setActionError(result.message ?? 'The horizon could not be made active.')
        }
      } finally {
        setActivating(false)
        reload()
      }
    },
    [dialog, reload, roadmapFiles],
  )

  // --- Derived view model ---------------------------------------------------

  // Normalize the active ref once so every identity comparison (rail selection,
  // selected file, active board) compares on the same footing as the normalized
  // roadmapFiles refs, even if the orchestrator hands back a raw path.
  const normActiveRef = activeRef ? normalizeRelativePath(activeRef) : null
  const railEntries = useMemo(() => buildRoadmapRail(roadmapFiles, normActiveRef), [roadmapFiles, normActiveRef])
  const hasRoadmaps = roadmapFiles.length > 0
  // The effective selection: the user's pick when it still exists, else the active
  // roadmap, else the first rail row.
  const effectiveSelectedRef =
    (selectedRef && railEntries.some((entry) => entry.roadmapRef === selectedRef) ? selectedRef : null) ??
    normActiveRef ??
    railEntries[0]?.roadmapRef ??
    null
  const selectedFile = roadmapFiles.find((file) => file.roadmapRef === effectiveSelectedRef) ?? null
  const isActiveSelected = effectiveSelectedRef !== null && effectiveSelectedRef === normActiveRef
  const activeRoadmap =
    roadmaps.find((roadmap) => normalizeRelativePath(roadmap.roadmapRef) === normActiveRef) ?? null
  const inbox = activeRoadmap ? collectRoadmapInbox([activeRoadmap]) : []

  // The cross-project planner shows in the CANVAS while editing — the shell (and
  // its lifted top bar) stays mounted, so the door keeps its title, status, and
  // back affordance exactly like every other door's sub-views (Sprints pattern).
  const planning = planningRef && homePath ? normalizeRelativePath(planningRef) : null
  const planningFile = planning ? roadmapFiles.find((file) => file.roadmapRef === planning) ?? null : null
  const exitPlanning = (): void => {
    setPlanningRef(null)
    reload()
  }

  const railRows: RoadmapRailRow[] = railEntries.map((entry) => {
    if (entry.active && activeRoadmap) {
      const progress = roadmapProgress(activeRoadmap.lanes)
      return {
        roadmapRef: entry.roadmapRef,
        title: entry.title,
        active: true,
        running: progress.running > 0,
        stateLine: progress.total > 0 ? `Active · step ${progress.step} of ${progress.total}` : 'Active · nothing planned yet',
      }
    }
    return { roadmapRef: entry.roadmapRef, title: entry.title, active: false, running: false, stateLine: 'Draft' }
  })

  const bar = planning
    ? buildEditingBar(planningFile, planning === normActiveRef)
    : selectedFile
      ? buildBar(selectedFile, isActiveSelected, activeRoadmap, {
          onEditPlan: handleEditPlan,
          onPauseRoadmap: handlePauseRoadmap,
          onResumeRoadmap: handleResumeRoadmap,
          busyBoard,
          refreshing,
        })
      : undefined
  const rail = (
    <RoadmapRail
      rows={railRows}
      selectedRef={planning ?? effectiveSelectedRef}
      search={railSearch}
      onSelect={(ref) => {
        // Selecting from the rail while editing leaves the planner (edits
        // autosave, so nothing is lost) and shows that roadmap's canvas.
        if (planning) setPlanningRef(null)
        setSelectedRef(ref)
      }}
      onSearch={setRailSearch}
      onNewRoadmap={() => void handleCreateRoadmap()}
    />
  )
  const attention =
    !planning && isActiveSelected && inbox.length > 0 ? (
      <Section title="Waiting on you" count={inbox.length} level={3} inset={false}>
        <RoadmapWaitingOnYou entries={inbox} onSelect={handleSelectInbox} />
      </Section>
    ) : undefined

  return (
    <GlobalSurfaceShell
      ariaLabel="Horizon"
      bar={bar}
      attention={attention}
      rail={hasRoadmaps || error ? rail : undefined}
      onBack={planning ? exitPlanning : back.onBack}
      canGoBack={planning ? true : back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col">
        {actionError ? (
          <div className="shrink-0 px-6 pt-4">
            <InlineNotice tone="error" action={<GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>}>
              {actionError}
            </InlineNotice>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {planning && planningRef && homePath ? (
            <RoadmapPlannerView
              homePath={homePath}
              roadmapRef={planningRef}
              onBack={exitPlanning}
              onSaved={reload}
              onRevealItem={openPlanning}
            />
          ) : !hasRoadmaps ? (
            // A read failure with nothing loaded offers only the retry, never the
            // creation pitch (which would risk a duplicate file).
            error ? (
              <SurfaceCanvasState
                kind="error"
                title="Couldn’t load your horizon."
                hint="This is usually temporary."
                detail={error}
                onRetry={reload}
              />
            ) : loading ? (
              <SurfaceCanvasState kind="loading" label="Loading your horizon…" />
            ) : (
              <SurfaceCanvasState
                kind="empty"
                glyph={<RoadmapDoorGlyph />}
                title="No horizon yet"
                body={projectCount === 0 ? 'Open a project to plan a horizon.' : undefined}
                action={
                  <PrimaryButton onClick={() => void handleCreateRoadmap()} disabled={creating}>
                    {creating ? 'Creating…' : 'Plan your horizon'}
                  </PrimaryButton>
                }
              />
            )
          ) : isActiveSelected ? (
            // The active roadmap needs its runtime board; if that read failed (or is
            // still loading), surface it here rather than mislabelling it a draft.
            activeRoadmap ? (
              <RoadmapTracks
                roadmap={activeRoadmap}
                homePath={homePath}
                busyLane={busyLane}
                laneRefs={laneRefs}
                reload={reload}
                onApprove={handleApprove}
                onPause={handlePause}
                onResume={handleResume}
                onMerge={handleMerge}
                onSkip={handleSkip}
                onEditPlan={handleEditPlan}
                onOpenRun={handleOpenRun}
              />
            ) : (
              <SurfaceCanvasState
                kind="error"
                title="Couldn’t read this horizon."
                hint="This is usually temporary."
                detail={error ?? undefined}
                onRetry={reload}
              />
            )
          ) : selectedFile ? (
            // A draft has no runtime, so a transient orchestrator-state read failure
            // never blanks it out.
            <RoadmapDraftCanvas
              file={selectedFile}
              activating={activating}
              onEditPlan={() => handleEditPlan(selectedFile.roadmapRef)}
              onMakeActive={() => void handleMakeActive(selectedFile)}
            />
          ) : (
            <SurfaceCanvasState
              kind="error"
              title="Couldn’t read this horizon."
              hint="This is usually temporary."
              detail={error ?? undefined}
              onRetry={reload}
            />
          )}
        </div>
      </div>
    </GlobalSurfaceShell>
  )
}

// The surface bar while EDITING a plan: the roadmap's identity plus an honest
// "changes save automatically" sub — no actions (the editor's controls live with
// the plan), back exits to the board.
function buildEditingBar(file: RoadmapFileSummary | null, isActive: boolean): GlobalSurfaceBar {
  return {
    title: file?.title ?? 'Plan horizon',
    statusChip: <BarStatusChip tone={isActive ? 'accent' : 'neutral'} label={isActive ? 'Active' : 'Draft'} />,
    contextSub: 'Editing the plan — changes save automatically',
  }
}

// The surface bar for the selected roadmap (mockup §2): name · Active/Draft · the
// context sub · merge policy (active only, an honest readout, not a lookalike
// button) · Edit plan · Pause/Resume (active) — a draft's Make active lives in
// RoadmapDraftCanvas beside the plan it acts on.
function buildBar(
  file: RoadmapFileSummary,
  isActive: boolean,
  activeRoadmap: LoadedRoadmap | null,
  handlers: {
    onEditPlan: (roadmapRef: string) => void
    onPauseRoadmap: (roadmap: LoadedRoadmap) => void
    onResumeRoadmap: (roadmap: LoadedRoadmap) => void
    busyBoard: boolean
    /** A background re-read is in flight — a quiet header pulse, never a content blink. */
    refreshing: boolean
  },
): GlobalSurfaceBar {
  const active = isActive && activeRoadmap ? activeRoadmap : null
  const progress = active ? roadmapProgress(active.lanes) : null
  const trackCount = active ? active.lanes.length : file.tracks.length
  const stepCount = progress ? progress.total : file.totalSteps
  const contextSubText = progress && progress.running > 0
    ? `${plural(trackCount, 'track')} · ${plural(stepCount, 'step')} · ${progress.running} running`
    : `${plural(trackCount, 'track')} · ${plural(stepCount, 'step')}`
  const contextSub = (
    <span className="inline-flex items-center gap-2">
      {contextSubText}
      {handlers.refreshing ? (
        <span className="inline-flex items-center gap-1 text-[color:var(--text-subtle)]">
          <Spinner size={10} />
          Refreshing
        </span>
      ) : null}
    </span>
  )
  // The roadmap-level pause toggle: Pause while any track runs, Resume once every
  // track is paused; hidden for a roadmap with no tracks to steer.
  const allPaused = active !== null && active.lanes.length > 0 && active.lanes.every((lane) => Boolean(lane.parked))
  const anyPausable = active !== null && active.lanes.some((lane) => !lane.parked)
  return {
    title: file.title,
    statusChip: (
      <BarStatusChip tone={isActive ? 'accent' : 'neutral'} label={isActive ? 'Active' : 'Draft'} />
    ),
    contextSub,
    actions: (
      <>
        {active ? (
          <span className="text-[11px] text-[color:var(--text-subtle)]" title="How this horizon merges delivered work">
            Merges: {active.roadmap.policy.merge === 'auto' ? 'automatic' : 'you approve'}
          </span>
        ) : null}
        <GhostButton onClick={() => handlers.onEditPlan(file.roadmapRef)}>Edit plan</GhostButton>
        {active && allPaused ? (
          <GhostButton onClick={() => handlers.onResumeRoadmap(active)} disabled={handlers.busyBoard}>
            Resume
          </GhostButton>
        ) : active && anyPausable ? (
          <GhostButton onClick={() => void handlers.onPauseRoadmap(active)} disabled={handlers.busyBoard}>
            Pause
          </GhostButton>
        ) : null}
      </>
    ),
  }
}

// The active roadmap's tracks, full-width across the canvas (mockup §2 drops the
// max-width card squeeze). One column per track, each with its steering controls.
function RoadmapTracks({
  roadmap,
  homePath,
  busyLane,
  laneRefs,
  reload,
  onApprove,
  onPause,
  onResume,
  onMerge,
  onSkip,
  onEditPlan,
  onOpenRun,
}: {
  roadmap: LoadedRoadmap
  homePath: string | null
  busyLane: string | null
  laneRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>
  reload: () => void
  onApprove: (roadmapRef: string, lane: string) => void
  onPause: (roadmapRef: string, lane: string) => void
  onResume: (roadmapRef: string, lane: string) => void
  onMerge: (roadmapRef: string, lane: string) => void
  onSkip: (lane: string, unit: RoadmapBoardUnit) => void
  onEditPlan: (roadmapRef: string) => void
  onOpenRun: (statePath: string) => void
}): JSX.Element {
  const spansProjects = roadmap.roadmap.projects.length > 0
  if (roadmap.lanes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
          This horizon has no tracks yet.
        </p>
        <RoadmapVocabulary />
        <PrimaryButton onClick={() => onEditPlan(roadmap.roadmapRef)}>Edit plan</PrimaryButton>
      </div>
    )
  }
  const callbacks: RoadmapLaneCallbacks = {
    onApprove: (lane) => onApprove(roadmap.roadmapRef, lane),
    onPause: (lane) => onPause(roadmap.roadmapRef, lane),
    onResume: (lane) => onResume(roadmap.roadmapRef, lane),
    onMerge: (lane) => onMerge(roadmap.roadmapRef, lane),
    onSkip: (lane, unit) => onSkip(lane, unit),
    onEditPlan: () => onEditPlan(roadmap.roadmapRef),
    onOpenRun,
    busyLane,
  }
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex flex-wrap gap-3">
        {roadmap.lanes.map((lane) => (
          <div
            key={lane.lane}
            ref={(node) => {
              laneRefs.current.set(`${roadmap.roadmapRef}:${lane.lane}`, node)
            }}
            className="flex"
          >
            <RoadmapLaneColumn
              lane={lane}
              folderPath={homePath}
              callbacks={callbacks}
              onReloadBoard={reload}
              showProjectTag={spansProjects}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// Inert callbacks for the read-only draft tracks — the column renders no
// controls in readOnly mode, so none of these can fire.
const DRAFT_LANE_CALLBACKS: RoadmapLaneCallbacks = {
  onApprove: () => undefined,
  onPause: () => undefined,
  onResume: () => undefined,
  onMerge: () => undefined,
  onSkip: () => undefined,
  onEditPlan: () => undefined,
  onOpenRun: () => undefined,
  busyLane: null,
}

// A selected DRAFT: not orchestrated, so no steering chrome — but the PLAN
// itself shows in full (the same track columns the active board uses, read-only,
// resolved against live backlog status), with the two honest actions on top:
// Edit plan and the explicit Make active.
function RoadmapDraftCanvas({
  file,
  activating,
  onEditPlan,
  onMakeActive,
}: {
  file: RoadmapFileSummary
  activating: boolean
  onEditPlan: () => void
  onMakeActive: () => void
}): JSX.Element {
  const spansProjects = file.lanes.some((lane) => lane.units.some((unit) => unit.projectKey !== null))
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="flex w-full flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex max-w-[62ch] flex-col gap-1">
            <h3 className="text-[14px] font-semibold text-[color:var(--text-strong)]">Draft horizon</h3>
            <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              This plan isn’t running yet. Make it active to have Multicode work it, one sprint at a time.
            </p>
            <RoadmapVocabulary />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <PrimaryButton onClick={onMakeActive} disabled={activating}>
              {activating ? 'Making active…' : 'Make active'}
            </PrimaryButton>
            <GhostButton onClick={onEditPlan}>Edit plan</GhostButton>
          </div>
        </div>
        {file.lanes.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {file.lanes.map((lane) => (
              <div key={lane.lane} className="flex">
                <RoadmapLaneColumn
                  lane={lane}
                  folderPath={null}
                  callbacks={DRAFT_LANE_CALLBACKS}
                  onReloadBoard={() => undefined}
                  showProjectTag={spansProjects}
                  readOnly
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-[color:var(--border-default)] px-3 py-4 text-center text-[12px] text-[color:var(--text-muted)]">
            No tracks yet — open Edit plan to lay out the work.
          </p>
        )}
      </div>
    </div>
  )
}

// The plain-human vocabulary (epic requirement): a first-time user can read what a
// track and a step are without leaving the surface.
function RoadmapVocabulary(): JSX.Element {
  return (
    <p className="max-w-[52ch] text-[12px] leading-5 text-[color:var(--text-subtle)]">
      A <strong className="font-medium text-[color:var(--text-muted)]">track</strong> is a lane of steps that run in
      order, one sprint at a time; tracks run side by side. A{' '}
      <strong className="font-medium text-[color:var(--text-muted)]">step</strong> is one backlog item or epic.
    </p>
  )
}

// The Horizon door mark: a sun setting on the horizon line (16-box round-stroke
// idiom, matching the nav entry's glyph).
function RoadmapDoorGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-7 w-7" aria-hidden="true">
      <path d="M4.8 11 a3.2 3.2 0 0 1 6.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2 11 H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 5.4 V3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.2 6.8 3.2 5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.8 6.8 12.8 5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
