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
import { buildRoadmapRail, roadmapProgress, skipRoadmapEntry } from '../../../../../shared/sprintengine/roadmap-surface'
import { serializeBacklogFrontmatterFields } from '../../../../../shared/backlog/frontmatter'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { GhostButton, PrimaryButton, Section, useConfirmDialog } from '../../ui'
import { newRoadmapFileContent } from '../../backlog/roadmapAuthoring'
import { backlogRootPath, normalizeRelativePath } from '../../../utils/backlog'
import { basename, joinFilePath, samePath, slugify } from '../../../utils/paths'
import { revealNavRailComponent } from '../../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../../utils/backlogReveal'
import { StatusDot } from '../../ui/StatusDot'
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
  const { roadmaps, roadmapFiles, activeRef, loading, error, homePath, reload } = useRoadmapBoard()
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
  // The roadmap file being planned in the in-surface cross-project planner, or
  // null when the steering board is showing. Planning happens here — no detour to
  // a single project's Backlog panel.
  const [planningRef, setPlanningRef] = useState<string | null>(null)
  // Which rail roadmap the canvas shows. Null falls back to the active roadmap.
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const laneRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

  const runLaneCommand = useCallback(
    async (lane: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
      setBusyLane(lane)
      try {
        const result = await action()
        if (!result.ok && result.message) {
          await dialog.confirm({ title: 'That action could not complete', body: result.message, confirmLabel: 'OK' })
        }
      } finally {
        setBusyLane(null)
        reload()
      }
    },
    [dialog, reload],
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
            await dialog.confirm({ title: 'That action could not complete', body: result.message, confirmLabel: 'OK' })
            break
          }
        }
      } finally {
        setBusyBoard(false)
        reload()
      }
    },
    [dialog, reload],
  )

  const handlePauseRoadmap = useCallback(
    async (roadmap: LoadedRoadmap) => {
      const lanes = roadmap.lanes.filter((lane) => !lane.parked).map((lane) => lane.lane)
      if (lanes.length === 0) return
      const ok = await dialog.confirm({
        title: `Pause ${roadmap.title}?`,
        body: 'Every track stops starting or merging new work until you resume it. Sprints already running keep going.',
        confirmLabel: 'Pause roadmap',
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

  // Skip removes the step from the roadmap file (the source of truth) in the home
  // project; the orchestrator advances past the removed step on its next reconcile.
  const handleSkip = useCallback(
    async (roadmap: LoadedRoadmap, lane: string, unit: RoadmapBoardUnit) => {
      if (!homePath) return
      const reason = await dialog.prompt({
        title: `Skip “${unit.title}”?`,
        body: 'This removes the step from this track so the roadmap moves past it. Tell us why — it is recorded in the roadmap file.',
        confirmLabel: 'Skip step',
        inputLabel: 'Reason for skipping',
        placeholder: 'e.g. superseded by another item',
        required: true,
        validate: (value) => (value.trim().length === 0 ? 'A reason is required.' : null),
      })
      if (reason === null) return
      setBusyLane(lane)
      try {
        const absolute = joinFilePath(homePath, roadmap.roadmapRef)
        const content = await window.api.readfile(absolute)
        const next = skipRoadmapEntry(content, unit.ref, reason.trim(), new Date().toISOString().slice(0, 10))
        if (next !== content) {
          await window.api.writefile(absolute, next)
        } else {
          await dialog.confirm({
            title: 'That step could not be skipped',
            body: 'This step was not found in the roadmap file, so nothing changed. Refresh and try again, or open “Edit plan” to change it directly.',
            confirmLabel: 'OK',
          })
        }
      } finally {
        setBusyLane(null)
        reload()
      }
    },
    [homePath, dialog, reload],
  )

  // Reveal a backlog file in its project's Backlog panel. Cross-project safe: the
  // item may live in any project, so it routes to that project's workspace (which
  // clears this surface) and otherwise leaves the surface in place.
  const openPlanning = useCallback(
    (projectRoot: string, relativePath: string) => {
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((candidate) => samePath(candidate.folderPath, projectRoot))
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
      await dialog.confirm({
        title: 'Open a project first',
        body: 'A roadmap orchestrates work across your projects. Open at least one project, then plan your roadmap.',
        confirmLabel: 'OK',
      })
      return
    }
    const projectName = basename(projectRoot)
    const name = (
      await dialog.prompt({
        title: 'New roadmap',
        body: homePath
          ? 'Name your roadmap. It can line up work from every project in this Multicode.'
          : `Your roadmap will live in ${projectName} and can line up work from every project in this Multicode.`,
        inputLabel: 'Roadmap name',
        placeholder: 'e.g. Next quarter',
        confirmLabel: 'Create',
        required: true,
        validate: (value) => (value.trim().length === 0 ? 'A name is required.' : null),
      })
    )?.trim()
    if (!name) return
    setCreating(true)
    try {
      const roadmapsDir = await window.api.ensureDir(backlogRootPath(projectRoot), 'roadmaps')
      const fileName = `${todayPrefix()}-${slugify(name)}.md`
      const newPath = await window.api.createFile(roadmapsDir, fileName)
      await window.api.writefile(newPath, newRoadmapFileContent(name))
      if (!homePath) {
        const set = await window.api.setRoadmapHomeProject(projectRoot)
        if (!set.ok) {
          await dialog.confirm({
            title: 'Could not set the home project',
            body: set.message ?? 'The roadmap home project could not be saved.',
            confirmLabel: 'OK',
          })
          return
        }
      }
      const newRef = normalizeRelativePath(`backlog/roadmaps/${fileName}`)
      reload()
      setSelectedRef(newRef)
      setPlanningRef(newRef)
    } catch (createError) {
      await dialog.confirm({
        title: 'Could not create the roadmap',
        body: createError instanceof Error ? createError.message : String(createError),
        confirmLabel: 'OK',
      })
    } finally {
      setCreating(false)
    }
  }, [dialog, homePath, reload])

  // Make a draft the single active roadmap (epic 1687 D1): promote it to `ready`
  // and demote every OTHER active-status roadmap to `idea`, so exactly one file is
  // active and the orchestrator's newest-id pick is never ambiguous. Frontmatter-
  // only writes (body byte-stable); the orchestrator adopts the new plan on its
  // next reconcile. An explicit, confirmed action — never a silent switch.
  const handleMakeActive = useCallback(
    async (file: RoadmapFileSummary) => {
      if (!homePath) return
      const demoting = roadmapFiles.filter(
        (candidate) => candidate.roadmapRef !== file.roadmapRef && ACTIVE_ROADMAP_STATUSES.has(candidate.status),
      )
      const ok = await dialog.confirm({
        title: `Make “${file.title}” the active roadmap?`,
        body:
          demoting.length > 0
            ? `The orchestrator runs one roadmap at a time. “${demoting[0].title}” becomes a draft — its running sprints finish, but nothing new starts on it until you make it active again.`
            : 'The orchestrator will start working this roadmap, one sprint at a time.',
        confirmLabel: 'Make active',
      })
      if (!ok) return
      setActivating(true)
      try {
        for (const candidate of demoting) {
          await writeRoadmapStatus(homePath, candidate.roadmapRef, 'idea')
        }
        await writeRoadmapStatus(homePath, file.roadmapRef, 'ready')
        setSelectedRef(file.roadmapRef)
      } catch (activateError) {
        await dialog.confirm({
          title: 'Could not make this roadmap active',
          body: activateError instanceof Error ? activateError.message : String(activateError),
          confirmLabel: 'OK',
        })
      } finally {
        setActivating(false)
        reload()
      }
    },
    [dialog, homePath, reload, roadmapFiles],
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

  // The cross-project planner takes over the whole surface while editing.
  if (planningRef && homePath) {
    return (
      <RoadmapPlannerView
        homePath={homePath}
        roadmapRef={planningRef}
        onBack={() => {
          setPlanningRef(null)
          reload()
        }}
        onSaved={reload}
        onRevealItem={openPlanning}
      />
    )
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

  const bar = selectedFile
    ? buildBar(selectedFile, isActiveSelected, activeRoadmap, {
        onEditPlan: handleEditPlan,
        onPauseRoadmap: handlePauseRoadmap,
        onResumeRoadmap: handleResumeRoadmap,
        busyBoard,
      })
    : undefined
  const rail = (
    <RoadmapRail
      rows={railRows}
      selectedRef={effectiveSelectedRef}
      onSelect={setSelectedRef}
      onNewRoadmap={() => void handleCreateRoadmap()}
    />
  )
  const attention =
    isActiveSelected && inbox.length > 0 ? (
      <Section title="Waiting on you" count={inbox.length} level={3} inset={false}>
        <RoadmapWaitingOnYou entries={inbox} onSelect={handleSelectInbox} />
      </Section>
    ) : undefined

  return (
    <GlobalSurfaceShell ariaLabel="Roadmap" bar={bar} attention={attention} rail={hasRoadmaps ? rail : undefined}>
      {!hasRoadmaps ? (
        // A read failure with nothing loaded offers only the retry, never the
        // creation pitch (which would risk a duplicate file).
        error ? (
          <RoadmapLoadError message={error} onRetry={reload} />
        ) : (
          <RoadmapEmptyState
            loading={loading}
            creating={creating}
            projectCount={projectCount}
            onCreate={() => void handleCreateRoadmap()}
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
          <RoadmapCanvasError message={error ?? 'This roadmap could not be loaded.'} onRetry={reload} />
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
        <RoadmapCanvasError message={error ?? 'This roadmap could not be loaded.'} onRetry={reload} />
      )}
    </GlobalSurfaceShell>
  )
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
  },
): GlobalSurfaceBar {
  const active = isActive && activeRoadmap ? activeRoadmap : null
  const progress = active ? roadmapProgress(active.lanes) : null
  const trackCount = active ? active.lanes.length : file.tracks.length
  const stepCount = progress ? progress.total : file.totalSteps
  const contextSub = progress && progress.running > 0
    ? `${plural(trackCount, 'track')} · ${plural(stepCount, 'step')} · ${progress.running} running`
    : `${plural(trackCount, 'track')} · ${plural(stepCount, 'step')}`
  // The roadmap-level pause toggle: Pause while any track runs, Resume once every
  // track is paused; hidden for a roadmap with no tracks to steer.
  const allPaused = active !== null && active.lanes.length > 0 && active.lanes.every((lane) => Boolean(lane.parked))
  const anyPausable = active !== null && active.lanes.some((lane) => !lane.parked)
  return {
    title: file.title,
    statusChip: (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--text-muted)]">
        <StatusDot tone={isActive ? 'accent' : 'neutral'} label={isActive ? 'Active roadmap' : 'Draft roadmap'} />
        {isActive ? 'Active' : 'Draft'}
      </span>
    ),
    contextSub,
    actions: (
      <>
        {active ? (
          <span className="text-[11px] text-[color:var(--text-subtle)]" title="How this roadmap merges delivered work">
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
  onSkip: (roadmap: LoadedRoadmap, lane: string, unit: RoadmapBoardUnit) => void
  onEditPlan: (roadmapRef: string) => void
  onOpenRun: (statePath: string) => void
}): JSX.Element {
  const spansProjects = roadmap.roadmap.projects.length > 0
  if (roadmap.lanes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
          This roadmap has no tracks yet.
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
    onSkip: (lane, unit) => onSkip(roadmap, lane, unit),
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

// A selected DRAFT: not orchestrated, so no steering chrome. It shows the plan at
// a glance (tracks + step counts), teaches the vocabulary, and offers the two
// honest actions — Edit plan and the explicit Make active.
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
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-8">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold text-[color:var(--text-strong)]">Draft roadmap</h3>
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            This plan isn’t running yet. Make it active to have the orchestrator work it, one sprint at a time.
          </p>
        </div>
        <RoadmapVocabulary />
        {file.tracks.length > 0 ? (
          <ul className="flex flex-col gap-px rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
            {file.tracks.map((track, index) => (
              <li
                key={`${track.title}:${index}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
              >
                <span className="min-w-0 truncate text-[color:var(--text-default)]" title={track.title}>
                  {track.title}
                </span>
                <span className="shrink-0 tabular-nums text-[color:var(--text-subtle)]">{plural(track.steps, 'step')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-[color:var(--border-default)] px-3 py-4 text-center text-[12px] text-[color:var(--text-muted)]">
            No tracks yet — open Edit plan to lay out the work.
          </p>
        )}
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={onMakeActive} disabled={activating}>
            {activating ? 'Making active…' : 'Make active'}
          </PrimaryButton>
          <GhostButton onClick={onEditPlan}>Edit plan</GhostButton>
        </div>
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

// The empty state IS the creation flow (mockup §1: never a dead end) — kept lean,
// a heading + one CTA.
function RoadmapEmptyState({
  loading,
  creating,
  projectCount,
  onCreate,
}: {
  loading: boolean
  creating: boolean
  projectCount: number
  onCreate: () => void
}): JSX.Element {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
        Loading your roadmap…
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 flex h-16 w-16 items-center justify-center rounded-full bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]">
        <RoadmapDoorGlyph />
      </div>
      <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">No roadmap yet</h3>
      <PrimaryButton onClick={onCreate} disabled={creating} className="mt-1">
        {creating ? 'Creating…' : 'Plan your roadmap'}
      </PrimaryButton>
      {projectCount === 0 ? (
        <span className="mt-3 text-[11px] text-[color:var(--text-subtle)]">Open a project to plan a roadmap.</span>
      ) : null}
    </div>
  )
}

// A read failure with no loaded roadmaps: offer only the retry, never the creation
// pitch that would risk a duplicate file (fallback discipline).
function RoadmapLoadError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <p className="max-w-[42ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
        We couldn’t load your roadmap: {message}. This is usually temporary — try again in a moment.
      </p>
      <GhostButton onClick={onRetry}>Try again</GhostButton>
    </div>
  )
}

// A read failure that leaves the rail populated (roadmaps loaded but a later read
// failed): a compact in-canvas banner, so the rail stays usable.
function RoadmapCanvasError({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="max-w-[42ch] text-[12px] leading-5 text-[color:var(--tone-warn)]">
        Could not read this roadmap: {message}
      </p>
      <GhostButton onClick={onRetry}>Try again</GhostButton>
    </div>
  )
}

function RoadmapDoorGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-7 w-7" aria-hidden="true">
      <circle cx="4" cy="3.6" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6 3.6 H10.6 A2.2 2.2 0 0 1 10.6 8 H5.4 A2.2 2.2 0 0 0 5.4 12.4 H10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

// Write a roadmap file's frontmatter status, preserving the body byte-for-byte
// (the shared serializer's hard contract). Used by Make active to promote/demote.
async function writeRoadmapStatus(homePath: string, roadmapRef: string, status: 'ready' | 'idea'): Promise<void> {
  const absolute = joinFilePath(homePath, roadmapRef)
  const content = await window.api.readfile(absolute)
  const next = serializeBacklogFrontmatterFields(content, { status })
  if (next !== content) await window.api.writefile(absolute, next)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function todayPrefix(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
