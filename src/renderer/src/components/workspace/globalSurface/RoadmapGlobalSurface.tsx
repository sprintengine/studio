// The Horizon tenant of the door-routed full-page surface (global-surfaces epic
// 1704; rebuilt by epic 1920 against mockup
// `backlog/mockups/2026-07-27-horizon-plan-detail-v2.html`). Mounted by
// WorkspaceManager over the workspace card region when the Horizon door opens —
// no scrim, no card, no Escape trap: this is a page, not a dialog.
//
// Anatomy: a horizons RAIL (every horizon file in this Multicode, exactly one
// Active, the rest drafts), a surface BAR (name · Active/Draft · the ONE
// progress readout · Saved · Pause), a 360px PLAN COLUMN of one-line selectable
// steps, and a DETAIL pane for the selected step. A Horizon step IS a backlog
// item, so the plan column reads as a worklist and the detail is the Backlog
// door's own detail — Horizon adds exactly one thing Backlog cannot know: which
// sprint is delivering this step.
//
// There is no separate "waiting on you" strip (MC-1922) and no edit mode
// (MC-1926): an approval, a merge or a park shows on the track it belongs to
// beside the control that resolves it, and every plan edit is a write to the
// horizon file, autosaved.
//
// The board/orchestrator/substrate underneath carry over unchanged: every
// steering control is a file/store write the orchestrator reconciles against,
// and the horizon file (in its D1 home project) is the source of truth.

import React, { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { roadmapProgress } from '../../../../../shared/sprintengine/roadmap-surface'
import { buildRoadmapRail } from '../../../../../shared/sprintengine/roadmap-surface'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  GhostButton,
  InlineNotice,
  Popover,
  PrimaryButton,
  SegmentedControl,
  Spinner,
  Tooltip,
  useConfirmDialog,
} from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
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
import { RoadmapRail, type RoadmapRailRow } from '../../panels/roadmapBoard/RoadmapRail'
import { HorizonPlanColumn } from '../../panels/roadmapBoard/HorizonPlanColumn'
import { buildHorizonPlan, type HorizonStepRow } from '../../panels/roadmapBoard/horizonPlanModel'
import { useHorizonLibrary } from '../../panels/roadmapBoard/useHorizonLibrary'
import { useRoadmapPlanDraft } from '../../backlog/useRoadmapPlanDraft'
import {
  addLibraryEntry,
  epicEntryDrift,
  refDisplayMapMulti,
  removeLane,
  renameLane,
  resyncEpicEntry,
  roadmapItemStatesMulti,
  splitAuthoredRef,
} from '../../backlog/roadmapAuthoring'
import { RosterMenu } from '../../backlog/RosterMenu'
import { RosterManagerModal } from '../../backlog/RosterManagerModal'
import { NO_ROLES_ROSTER_NAME } from '../newWorkspace/savedRosters'
import {
  HorizonDetailPane,
  resolveStepItem,
  useHorizonDetailChoices,
  type HorizonStepRun,
  type HorizonStepUnresolved,
} from '../../panels/roadmapBoard/HorizonDetailPane'
import { HorizonBacklogSource } from '../../panels/roadmapBoard/HorizonBacklogSource'
import { useAllProjectsBacklog } from '../../../hooks/useAllProjectsBacklog'
import { refreshSharedBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { createBacklogDoorActions, type BacklogDoorMutationApi } from './backlog/backlogDoorActions'
import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { focusOrAddFileTab } from '../../../utils/modelRegistry'
import type { BacklogLinkProvider } from '../../../modules/renderer-host'
import { validateRoadmap, type ProjectKey, type RoadmapPolicy } from '../../../../../shared/backlog/roadmap'
import type { SprintEngineRoster } from '../../../types/workspace'
import type { BacklogItem } from '../../../utils/backlog'
import type { BacklogProjectRef } from '../../../hooks/useAllProjectsBacklog'
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
  // The horizon whose delete is in flight, so its rail row cannot be double-fired.
  const [deleting, setDeleting] = useState<string | null>(null)
  // A steering command (approve/merge/pause/skip/create/activate) that fails is a
  // non-blocking error card at the top of the canvas, never a confirm-as-alert
  // dialog that hijacks the surface (T20 / mockup: failures never block).
  const [actionError, setActionError] = useState<string | null>(null)
  const back = useSurfaceBackNav()
  // Which rail horizon the surface shows. Null falls back to the active horizon.
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  // The rail's search query — transient per-window view state.
  const [railSearch, setRailSearch] = useState('')
  // The selected STEP, by authored ref — the one selection driving the detail.
  const [selectedStepRef, setSelectedStepRef] = useState<string | null>(null)
  const [rosterManagerOpen, setRosterManagerOpen] = useState(false)
  // The detail pane's second mode: the backlog you drag work from. One slot,
  // two modes — never a fourth column.
  const [backlogOpen, setBacklogOpen] = useState(false)
  // A backlog row is being dragged, shared so a track can accept the drop. Both
  // panes live in one tree, so React state is the transport — no dataTransfer
  // round-trip needed for the payload.
  const [libraryDrag, setLibraryDrag] = useState<string | null>(null)

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

  // Horizon-level pause/resume (surface bar): loops the SAME per-lane command
  // over every track once, so it is a convenience over the existing controls —
  // never a new orchestrator primitive. Stops on the first failure and surfaces
  // it, then reloads once.
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
  // Resume is the one steering control whose consequence depends on what the
  // parked run did. Over a run that already DELIVERED it would discard finished
  // work and plan the step again from scratch, so the orchestrator refuses until
  // that is acknowledged in its own words (MC-1909) — never as a side effect of
  // one click on a button labelled "Resume".
  const handleResume = useCallback(
    async (roadmapRef: string, lane: string) => {
      setBusyLane(lane)
      let result: { ok: boolean; message?: string; confirm?: string }
      try {
        result = await window.api.resumeRoadmapLane(commandInput(roadmapRef, lane))
      } finally {
        setBusyLane(null)
        reload()
      }
      if (result.ok) return
      if (result.confirm !== 'replan_delivered_run') {
        if (result.message) setActionError(result.message)
        return
      }
      const startOver = await dialog.confirm({
        title: `Start ${lane} over?`,
        body:
          result.message ??
          'This sprint finished its work. Starting over throws it away and plans a new sprint for the same step.',
        confirmLabel: 'Throw it away and start over',
      })
      if (!startOver) return
      void runLaneCommand(lane, () =>
        window.api.resumeRoadmapLane({ ...commandInput(roadmapRef, lane), replanDeliveredRun: true }),
      )
    },
    [commandInput, dialog, reload, runLaneCommand],
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

  // Reveal a backlog file in its project's Backlog panel. Cross-project safe: the
  // item may live in any project, so it routes to that project's workspace (which
  // clears this surface) and otherwise leaves the surface in place. Several
  // workspaces can share the project root — every sprint run mounts one — so
  // prefer a PLAIN workspace: opening a step must show the item's detail, never
  // dump the user into whichever sprint happens to share the folder.
  const openInProject = useCallback(
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

  // Create a new horizon: pick the home project (D1), write the file (a DRAFT —
  // status idea, so nothing runs until it is made active), set the home project
  // if unset, and select it.
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
          : `Your horizon will live in ${projectName} and can line up work from every project in this Multicode.`,
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
      // One main-process op writes the draft file and, when this Multicode has no
      // home project yet, adopts this one — no sequential renderer file IO to strand.
      const result = await window.api.createRoadmap({ projectRoot, name })
      if (!result.ok) {
        setActionError(result.message)
        return
      }
      reload()
      setSelectedRef(result.roadmapRef)
      setSelectedStepRef(null)
    } finally {
      setCreating(false)
    }
  }, [dialog, homePath, reload])

  // Delete a horizon file (MC-1922). The confirm names exactly what goes and what
  // stays — the plan only; the backlog items it lines up and the sprints it
  // already delivered are untouched. The orchestrator refuses while a sprint is
  // running on it and says which track, so that refusal surfaces as the normal
  // action error rather than a silent no-op.
  const handleDeleteRoadmap = useCallback(
    async (roadmapRef: string) => {
      const file = roadmapFiles.find((candidate) => candidate.roadmapRef === roadmapRef)
      if (!file) return
      // Normalized here rather than read from the derived view model below: this
      // callback is declared above it, so depending on that binding would evaluate
      // it before its declaration.
      const isActive = activeRef !== null && normalizeRelativePath(roadmapRef) === normalizeRelativePath(activeRef)
      const ok = await dialog.confirm({
        title: `Delete “${file.title}”?`,
        body: [
          'This deletes the horizon file.',
          file.totalSteps > 0
            ? 'The backlog items it lines up are not touched, and any sprint it already delivered keeps its branch and pull request.'
            : 'No backlog items are touched.',
          isActive ? 'This is your active horizon, so Multicode will stop working it.' : null,
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Delete horizon',
        tone: 'danger',
      })
      if (!ok) return
      setDeleting(roadmapRef)
      try {
        const result = await window.api.deleteRoadmap({ roadmapRef })
        if (!result.ok) {
          setActionError(result.message ?? 'This horizon could not be deleted.')
          return
        }
        // Drop a selection that pointed at the deleted file so the canvas falls
        // back to the active horizon (or the first rail row) instead of rendering
        // a "couldn't read this horizon" error for something we deleted on purpose.
        setSelectedRef((current) => (current === roadmapRef ? null : current))
      } finally {
        setDeleting(null)
        reload()
      }
    },
    [activeRef, dialog, reload, roadmapFiles],
  )

  // Reveal a horizon file in the Backlog panel of the home project it lives in.
  // `openInProject` routes into a workspace open on that project and does nothing
  // without one, so the affordance is only offered when it can actually land — a
  // menu item is never shown as a control that quietly does nothing.
  const canRevealHomeFile = useWorkspaceStore(
    (state) => homePath !== null && state.workspaces.some((candidate) => samePath(candidate.folderPath, homePath)),
  )
  const handleRevealRoadmapFile = useCallback(
    (roadmapRef: string) => {
      if (!homePath) return
      openInProject(homePath, normalizeRelativePath(roadmapRef))
    },
    [homePath, openInProject],
  )

  // Make a draft the single active horizon (epic 1687 D1): one main-process op
  // promotes it to `ready` and demotes every OTHER active-status horizon to
  // `idea`, atomically and in an order that can never strand zero active
  // horizons. An explicit, confirmed action — never a silent switch.
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
  // The effective selection: the user's pick when it still exists, else the
  // active horizon, else the first rail row.
  const effectiveSelectedRef =
    (selectedRef && railEntries.some((entry) => entry.roadmapRef === selectedRef) ? selectedRef : null) ??
    normActiveRef ??
    railEntries[0]?.roadmapRef ??
    null
  const selectedFile = roadmapFiles.find((file) => file.roadmapRef === effectiveSelectedRef) ?? null
  const isActiveSelected = effectiveSelectedRef !== null && effectiveSelectedRef === normActiveRef
  const activeRoadmap =
    roadmaps.find((roadmap) => normalizeRelativePath(roadmap.roadmapRef) === normActiveRef) ?? null

  // --- The plan: one draft, autosaved -------------------------------------

  const planItem: BacklogItem | null = selectedFile?.item ?? null
  const plan = useRoadmapPlanDraft({
    path: planItem?.path ?? '',
    relativePath: planItem?.relativePath ?? '',
    sourceContent: planItem?.sourceContent ?? '',
    onSaved: reload,
  })
  const library = useHorizonLibrary(homePath, planItem?.sourceContent ?? null)
  const savedRosters = useWorkspaceStore(
    useShallow((s) => s.appSettings.sprintEngineRoleSettings?.savedRosters ?? []),
  )

  const projectByKey = useCallback(
    (projectKey: ProjectKey) => library.projects.find((project) => project.projectKey === projectKey),
    [library.projects],
  )
  const itemsByProjectKey = useMemo(() => {
    const map = new Map<ProjectKey, ReadonlyArray<BacklogItem>>()
    for (const project of library.projects) map.set(project.projectKey, project.items)
    return map
  }, [library.projects])
  const refDisplay = useMemo(() => refDisplayMapMulti(library.projects), [library.projects])
  const projectNameByKey = useMemo(() => {
    const map = new Map<ProjectKey, string>()
    for (const project of library.projects) map.set(project.projectKey, project.projectName)
    return map
  }, [library.projects])

  // The epic drift affordance ("this epic gained N items → Update step"), keyed
  // by authored ref so the pure plan model never needs the scan itself. Each
  // epic reconciles against ITS OWN project's membership, not the home project's.
  const driftByRef = useMemo(() => {
    const map = new Map<string, { gained: number; removed: number }>()
    for (const lane of plan.draft.lanes) {
      for (const entry of lane.entries) {
        if (entry.kind !== 'epic') continue
        const drift = epicEntryDrift(itemsByProjectKey.get(entry.projectKey) ?? [], entry)
        if (drift) map.set(entry.ref, { gained: drift.gained.length, removed: drift.removed.length })
      }
    }
    return map
  }, [plan.draft.lanes, itemsByProjectKey])

  // A plan can be edited into an ordering loop — steps that must run before
  // themselves. The deleted editor was the only place that said so, and dragging
  // must not become a quiet way to write one: the warning moves onto this screen.
  // Note the save itself is NOT gated: a dangling ref is deliberately writable
  // and visible (Fallback Discipline) rather than silently refused.
  const hasCycle = useMemo(() => {
    if (plan.draft.lanes.length === 0) return false
    return validateRoadmap(
      {
        policy: plan.draft.policy,
        projects: plan.draft.projects,
        title: plan.draft.title,
        lanes: plan.draft.lanes,
        body: '',
        issues: [],
      },
      roadmapItemStatesMulti(library.projects),
    ).hasCycle
  }, [plan.draft, library.projects])

  // The tag is earned only by a horizon that actually spans projects — repeating
  // one project's name on every row of a single-project plan is the noise the
  // density pass removed.
  const spansProjects = useMemo(
    () => plan.draft.lanes.some((lane) => lane.entries.some((entry) => entry.projectKey !== null)),
    [plan.draft.lanes],
  )

  const horizonPlan = useMemo(
    () =>
      buildHorizonPlan({
        lanes: plan.draft.lanes,
        // The runtime overlay exists only for the ACTIVE horizon; a draft reads
        // from backlog status alone, which is the honest draft frontier.
        boardLanes: isActiveSelected && activeRoadmap ? activeRoadmap.lanes : (selectedFile?.lanes ?? []),
        refDisplay,
        projectNameByKey,
        policyRoster: plan.draft.policy.roster,
        knownRosterNames: new Set([
          NO_ROLES_ROSTER_NAME.toLowerCase(),
          ...savedRosters.map((roster) => roster.name.trim().toLowerCase()),
        ]),
        defaultRosterLabel: NO_ROLES_ROSTER_NAME,
        driftByRef,
      }),
    [
      plan.draft.lanes,
      plan.draft.policy.roster,
      isActiveSelected,
      activeRoadmap,
      selectedFile,
      refDisplay,
      projectNameByKey,
      savedRosters,
      driftByRef,
    ],
  )

  const addRef = useCallback(
    (laneIndex: number, value: string, index?: number) => {
      const { projectKey, relativePath } = splitAuthoredRef(value)
      const project = projectByKey(projectKey)
      if (!project) return
      plan.update((draft) => addLibraryEntry(draft, laneIndex, project, relativePath, index))
    },
    [plan, projectByKey],
  )

  const handleResyncEpic = useCallback(
    (laneIndex: number, entryIndex: number) => {
      const entry = plan.draft.lanes[laneIndex]?.entries[entryIndex]
      if (!entry) return
      plan.setLanes(
        resyncEpicEntry(itemsByProjectKey.get(entry.projectKey) ?? [], plan.draft.lanes, laneIndex, entryIndex),
      )
    },
    [plan, itemsByProjectKey],
  )

  const handleOpenStep = useCallback(
    (row: HorizonStepRow) => {
      const { projectKey, relativePath } = splitAuthoredRef(row.ref)
      const project = projectByKey(projectKey)
      if (!project) return
      openInProject(project.path, relativePath)
    },
    [projectByKey, openInProject],
  )

  const handleRenameTrack = useCallback(
    async (laneIndex: number) => {
      const lane = plan.draft.lanes[laneIndex]
      if (!lane) return
      const next = await dialog.prompt({
        title: 'Rename track',
        inputLabel: 'Track name',
        initialValue: lane.title,
        confirmLabel: 'Rename',
        required: true,
        validate: (value) => (value.trim().length === 0 ? 'A name is required.' : null),
      })
      if (next === null) return
      const trimmed = next.trim()
      if (!trimmed || trimmed === lane.title) return
      plan.setLanes(renameLane(plan.draft.lanes, laneIndex, trimmed))
    },
    [dialog, plan],
  )

  const handleRemoveTrack = useCallback(
    async (laneIndex: number) => {
      const lane = plan.draft.lanes[laneIndex]
      if (!lane) return
      if (lane.entries.length > 0) {
        const ok = await dialog.confirm({
          title: 'Remove this track?',
          body: `“${lane.title}” has ${lane.entries.length} ${lane.entries.length === 1 ? 'step' : 'steps'}. Removing the track drops them from the horizon (the backlog items stay).`,
          confirmLabel: 'Remove track',
          tone: 'danger',
        })
        if (!ok) return
      }
      plan.setLanes(removeLane(plan.draft.lanes, laneIndex))
    },
    [dialog, plan],
  )

  // Steering is only ever real on the ACTIVE horizon — a draft has no runtime to
  // pause, approve or merge, so its tracks park none of these.
  const steeringRef = isActiveSelected ? effectiveSelectedRef : null
  const pausedLanes = useMemo(
    () =>
      new Set(
        (isActiveSelected && activeRoadmap ? activeRoadmap.lanes : []).filter((lane) => lane.parked).map((lane) => lane.lane),
      ),
    [isActiveSelected, activeRoadmap],
  )
  // --- The detail pane ------------------------------------------------------

  const { projects: backlogFeeds } = useAllProjectsBacklog()
  const now = useRelativeNow()
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const linkProviders = useMemo<BacklogLinkProvider[]>(
    () => getRendererHost().getBacklogLinkProviders((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )

  // The step whose detail is showing, resolved out of the plan (which already
  // joined the file to the live runtime) rather than re-derived from the draft.
  const selectedStep = useMemo(() => {
    if (!selectedStepRef) return null
    const rows = [...horizonPlan.bands.flatMap((band) => band.rows), ...horizonPlan.delivered.rows]
    return rows.find((row) => row.ref === selectedStepRef) ?? null
  }, [horizonPlan, selectedStepRef])

  const selectedStepProjectRoot = useMemo(() => {
    if (!selectedStep) return null
    return projectByKey(selectedStep.projectKey)?.path ?? null
  }, [selectedStep, projectByKey])

  const resolvedStep = useMemo(() => {
    if (!selectedStep) return null
    const { relativePath } = splitAuthoredRef(selectedStep.ref)
    return resolveStepItem(backlogFeeds, selectedStepProjectRoot, relativePath)
  }, [selectedStep, selectedStepProjectRoot, backlogFeeds])

  // WHY a step has no item: its project is not open, its project's scan has not
  // reported, or the file is genuinely gone. Decided against the step's OWN
  // project's feed — "some other project has finished scanning" says nothing
  // about this one, and would report a still-loading step as missing.
  const stepUnresolved = useMemo<HorizonStepUnresolved>(() => {
    if (!selectedStepProjectRoot) return 'project_unavailable'
    const feed = backlogFeeds.find((candidate) => samePath(candidate.root, selectedStepProjectRoot))
    if (!feed) return 'project_unavailable'
    return feed.loading && feed.items.length === 0 ? 'loading' : 'missing'
  }, [selectedStepProjectRoot, backlogFeeds])

  // A workspace mounted on the run's own state file, so "Open sprint" can land.
  const openRunStatePaths = useWorkspaceStore(
    useShallow((state) =>
      state.workspaces
        .map((workspace) => workspace.sprintEngineContext?.statePath)
        .filter((statePath): statePath is string => Boolean(statePath)),
    ),
  )

  // item -> project by OBJECT IDENTITY across every feed: two projects can hold
  // the same relativePath (and so the same item id), so identity — never the
  // path — is what routes a mutation to the right backlog.
  const projectByItem = useMemo(() => {
    const map = new Map<BacklogItem, BacklogProjectRef>()
    for (const feed of backlogFeeds) for (const entry of feed.items) map.set(entry.item, entry.project)
    return map
  }, [backlogFeeds])

  const { epicChoices, dependencyChoices } = useHorizonDetailChoices(resolvedStep?.feed ?? null)

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null)
    try {
      await fn()
    } catch (mutationError) {
      setActionError(mutationError instanceof Error ? mutationError.message : String(mutationError))
    }
  }, [])

  // The SAME mutation factory the Backlog door uses, so a status change made
  // from a Horizon step behaves exactly as it does from the Backlog.
  const detailActions = useMemo(
    () =>
      createBacklogDoorActions({
        api: window.api as unknown as BacklogDoorMutationApi,
        resolveProject: (item) => projectByItem.get(item) ?? null,
        itemsForProject: (rootKey) =>
          backlogFeeds.find((feed) => feed.rootKey === rootKey)?.items.map((entry) => entry.item) ?? [],
        refreshProject: (root) => void refreshSharedBacklogScan(root),
        runAction,
        confirmDialog: dialog.confirm,
        promptDialog: dialog.prompt,
        openInEditor: (item, project) =>
          void runAction(async () => {
            const workspace = useWorkspaceStore
              .getState()
              .workspaces.find((candidate) => candidate.folderPath === project.root)
            if (!workspace) {
              await window.api.showItemInFolder(item.path)
              return
            }
            const name = basename(item.relativePath)
            openFile(workspace.id, item.path, name, item.sourceContent)
            focusOrAddFileTab(workspace.id, item.path, name)
          }),
        revealInFiles: (item) =>
          void runAction(async () => {
            await window.api.showItemInFolder(item.path)
          }),
        // Creating an item is the Backlog door's job; a horizon plans work that
        // already exists, so this offers nothing rather than a dead control.
        openCreate: () => undefined,
      }),
    [projectByItem, backlogFeeds, runAction, dialog, openFile],
  )

  // The run delivering the selected step, from the track that holds it.
  const selectedRun = useMemo<HorizonStepRun | null>(() => {
    if (!selectedStep || !isActiveSelected || !activeRoadmap) return null
    const lane = activeRoadmap.lanes.find((candidate) => candidate.lane === selectedStep.laneTitle)
    if (!lane?.activeStatePath) return null
    // The run belongs to the step it is executing — a track's run strip must not
    // appear on a queued step further down the same track.
    if (lane.activeItemRef && lane.activeItemRef !== selectedStep.ref) return null
    return {
      statePath: lane.activeStatePath,
      lane: lane.lane,
      attention: lane.attention,
      busy: busyLane === lane.lane,
    }
  }, [selectedStep, isActiveSelected, activeRoadmap, busyLane])

  // Focus the running sprint's own workspace, when it is open. An autonomous run
  // may not be mounted as a workspace; the affordance is then inert, never a
  // broken link.
  const handleOpenRun = useCallback((statePath: string) => {
    const workspace = useWorkspaceStore
      .getState()
      .workspaces.find((candidate) => candidate.sprintEngineContext?.statePath === statePath)
    if (workspace) setActiveWorkspace(workspace.id)
  }, [setActiveWorkspace])

  const plannedRefs = useMemo(() => {
    const set = new Set<string>()
    for (const lane of plan.draft.lanes) for (const entry of lane.entries) set.add(entry.ref)
    return set
  }, [plan.draft.lanes])

  const steering = useMemo(
    () => ({
      busyLane,
      pausedLanes,
      onPause: (lane: string) => {
        if (steeringRef) void handlePause(steeringRef, lane)
      },
      onResume: (lane: string) => {
        if (steeringRef) void handleResume(steeringRef, lane)
      },
      onApprove: (lane: string) => {
        if (steeringRef) handleApprove(steeringRef, lane)
      },
      onMerge: (lane: string) => {
        if (steeringRef) handleMerge(steeringRef, lane)
      },
    }),
    [busyLane, pausedLanes, steeringRef, handlePause, handleResume, handleApprove, handleMerge],
  )

  // --- Chrome ---------------------------------------------------------------

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
        onPauseRoadmap: handlePauseRoadmap,
        onResumeRoadmap: handleResumeRoadmap,
        onMakeActive: () => void handleMakeActive(selectedFile),
        activating,
        busyBoard,
        refreshing,
        saveState: plan.saveState,
        onRetrySave: () => void plan.save(),
        policy: plan.draft.policy,
        onPolicy: plan.setPolicy,
        rosters: savedRosters,
        onManageRosters: () => setRosterManagerOpen(true),
      })
    : undefined

  const rail = (
    <RoadmapRail
      rows={railRows}
      selectedRef={effectiveSelectedRef}
      search={railSearch}
      onSelect={(ref) => {
        setSelectedRef(ref)
        setSelectedStepRef(null)
        setBacklogOpen(false)
      }}
      onSearch={setRailSearch}
      onNewRoadmap={() => void handleCreateRoadmap()}
      actions={{
        onMakeActive: (ref) => {
          const file = roadmapFiles.find((candidate) => candidate.roadmapRef === ref)
          if (file) void handleMakeActive(file)
        },
        ...(canRevealHomeFile ? { onRevealFile: handleRevealRoadmapFile } : {}),
        onDelete: (ref) => {
          if (deleting) return
          void handleDeleteRoadmap(ref)
        },
      }}
    />
  )

  return (
    <GlobalSurfaceShell
      ariaLabel="Horizon"
      bar={bar}
      rail={hasRoadmaps || error ? rail : undefined}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col">
        {actionError ? (
          <div className="shrink-0 px-6 pt-4">
            <InlineNotice tone="error" action={<GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>}>
              {actionError}
            </InlineNotice>
          </div>
        ) : null}
        {hasCycle ? (
          <div className="shrink-0 px-6 pt-4">
            <InlineNotice tone="warn">
              Some steps must run before themselves — an ordering loop. Reorder them or remove a
              prerequisite so the horizon can run start to finish.
            </InlineNotice>
          </div>
        ) : null}
        {plan.saveError ? (
          <div className="shrink-0 px-6 pt-4">
            <InlineNotice
              tone="error"
              title="Your latest plan edits couldn’t be saved."
              detail={plan.saveError}
              action={
                <GhostButton onClick={() => void plan.save()} disabled={plan.saving}>
                  Try again
                </GhostButton>
              }
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {!hasRoadmaps ? (
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
                body={
                  projectCount === 0
                    ? 'Open a project to plan a horizon.'
                    : 'A horizon lines up work across your projects and runs it one sprint at a time.'
                }
                action={
                  <PrimaryButton onClick={() => void handleCreateRoadmap()} disabled={creating}>
                    {creating ? 'Creating…' : 'Plan your horizon'}
                  </PrimaryButton>
                }
              />
            )
          ) : !selectedFile ? (
            <SurfaceCanvasState
              kind="error"
              title="Couldn’t read this horizon."
              hint="This is usually temporary."
              detail={error ?? undefined}
              onRetry={reload}
            />
          ) : !planItem ? (
            // The planner's not-found state, kept (MC-1926): a horizon can be
            // deleted or moved outside Multicode while the door is open. Once the
            // home scan HAS reported and the file is still not in it, saying
            // "loading" forever would be a lie.
            library.homeScanLoaded ? (
              <SurfaceCanvasState
                kind="error"
                title="This horizon file no longer exists."
                hint="It may have been moved or deleted outside Multicode."
                detail={selectedFile.roadmapRef}
                onRetry={reload}
              />
            ) : (
              <SurfaceCanvasState kind="loading" label="Loading your horizon…" />
            )
          ) : (
            <div className="flex h-full min-h-0">
              <HorizonPlanColumn
                plan={horizonPlan}
                lanes={plan.draft.lanes}
                selectedRef={selectedStepRef}
                onSelect={(ref) => {
                  setSelectedStepRef(ref)
                  // Selecting a step is a request to SEE it, so it returns the
                  // pane from the backlog to the step's own detail.
                  setBacklogOpen(false)
                }}
                showProjectTag={spansProjects}
                rosters={savedRosters}
                policyRoster={plan.draft.policy.roster}
                onManageRosters={() => setRosterManagerOpen(true)}
                onLanes={plan.setLanes}
                onAddRef={addRef}
                onResyncEpic={handleResyncEpic}
                onOpenItem={handleOpenStep}
                onAddWork={() => setBacklogOpen((open) => !open)}
                addWorkActive={backlogOpen}
                libraryDragRef={libraryDrag}
                steering={steering}
                onRenameTrack={(laneIndex) => void handleRenameTrack(laneIndex)}
                onRemoveTrack={(laneIndex) => void handleRemoveTrack(laneIndex)}
              />
              {/* Two modes, ONE slot — never a fourth column. */}
              {backlogOpen ? (
                <HorizonBacklogSource
                  projects={library.projects}
                  plannedRefs={plannedRefs}
                  canAdd={plan.draft.lanes.length > 0}
                  onClose={() => setBacklogOpen(false)}
                  onAdd={(ref) => addRef(0, ref)}
                  onDragStart={setLibraryDrag}
                  onDragEnd={() => setLibraryDrag(null)}
                />
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--bg-surface)]">
                  <HorizonDetailPane
                    step={selectedStep}
                    resolved={resolvedStep}
                    unresolved={stepUnresolved}
                    canOpenRun={selectedRun !== null && openRunStatePaths.includes(selectedRun.statePath)}
                    run={selectedRun}
                    homePath={homePath}
                    now={now}
                    actions={detailActions}
                    linkProviders={linkProviders}
                    epicChoices={epicChoices}
                    dependencyChoices={dependencyChoices}
                    onNavigate={(itemId) => {
                      // Navigating inside an item's detail (epic ⇄ child, a
                      // prerequisite) may land on work that is not a step in this
                      // horizon, so it opens in the item's own project Backlog
                      // rather than pretending the plan column can select it.
                      const target =
                        resolvedStep?.feed.items.find((entry) => entry.item.id === itemId)
                        ?? backlogFeeds.flatMap((feed) => feed.items).find((entry) => entry.item.id === itemId)
                      if (target) openInProject(target.project.root, target.item.relativePath)
                    }}
                    onReload={reload}
                    onPause={steering.onPause}
                    onResume={steering.onResume}
                    onApprove={steering.onApprove}
                    onMerge={steering.onMerge}
                    onOpenRun={handleOpenRun}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {rosterManagerOpen ? (
        <RosterManagerModal
          // The horizon's home project supplies the role registry. A horizon can
          // span projects, but rosters are a global user preference, so the
          // registry only decides which ROWS are offered.
          workspaceRoot={homePath}
          onClose={() => setRosterManagerOpen(false)}
          onRosterChosen={(name) => {
            plan.setPolicy({ roster: name })
            setRosterManagerOpen(false)
          }}
        />
      ) : null}
    </GlobalSurfaceShell>
  )
}

// The surface bar for the selected horizon (mockup frame 1): name · Active/Draft
// · the ONE progress readout · the Saved indicator · the horizon's own options ·
// the state's one action. There is no `Edit plan` and no editing bar (MC-1926):
// a draft uses the SAME screen — only its primary action differs.
function buildBar(
  file: RoadmapFileSummary,
  isActive: boolean,
  activeRoadmap: LoadedRoadmap | null,
  handlers: {
    onPauseRoadmap: (roadmap: LoadedRoadmap) => void
    onResumeRoadmap: (roadmap: LoadedRoadmap) => void
    onMakeActive: () => void
    activating: boolean
    busyBoard: boolean
    /** A background re-read is in flight — a quiet header pulse, never a content blink. */
    refreshing: boolean
    saveState: 'saved' | 'saving' | 'pending' | 'failed'
    onRetrySave: () => void
    /** The horizon's execution policy — live controls, not a separate screen. */
    policy: RoadmapPolicy
    onPolicy: (patch: Partial<RoadmapPolicy>) => void
    rosters: ReadonlyArray<SprintEngineRoster>
    onManageRosters: () => void
  },
): GlobalSurfaceBar {
  const active = isActive && activeRoadmap ? activeRoadmap : null
  const progress = active ? roadmapProgress(active.lanes) : null
  // ONE progress readout per surface: the bar owns it. The row's trailing count
  // owns step size and the detail's own bar owns an epic's children, so the old
  // "N tracks · M steps · K running" head count is gone.
  const contextSubText = progress
    ? progress.total > 0
      ? `Step ${progress.step} of ${progress.total}`
      : 'Nothing planned yet'
    : file.totalSteps > 0
      ? `${file.totalSteps} ${file.totalSteps === 1 ? 'step' : 'steps'}`
      : 'Nothing planned yet'
  const contextSub = (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums">{contextSubText}</span>
      {handlers.refreshing ? (
        <span className="inline-flex items-center gap-1 text-[color:var(--text-subtle)]">
          <Spinner size={10} />
          Refreshing
        </span>
      ) : null}
    </span>
  )
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
        <SavedIndicator state={handlers.saveState} onRetry={handlers.onRetrySave} />
        <HorizonPolicyMenu
          policy={handlers.policy}
          onChange={handlers.onPolicy}
          rosters={handlers.rosters}
          onManageRosters={handlers.onManageRosters}
        />
        {!isActive ? (
          <PrimaryButton onClick={handlers.onMakeActive} disabled={handlers.activating}>
            {handlers.activating ? 'Making active…' : 'Make active'}
          </PrimaryButton>
        ) : active && allPaused ? (
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

// The horizon's execution policy, in plain human terms: what happens after a
// step finishes, who merges delivered work, and which saved roster staffs each
// sprint. MC-1926 kept these as LIVE segmented controls when the planner screen
// that used to host them went away — they read well and were not redrawn, they
// just moved onto the one screen, behind the bar's own options affordance so a
// 360px-plus-detail layout does not grow a fourth band.
//
// (`policy.concurrency` is parsed and preserved but the orchestrator does not
// honour it yet — it serialises to one active run per repo — so no control is
// offered for it.)
function HorizonPolicyMenu({
  policy,
  onChange,
  rosters,
  onManageRosters,
}: {
  policy: RoadmapPolicy
  onChange: (patch: Partial<RoadmapPolicy>) => void
  rosters: ReadonlyArray<SprintEngineRoster>
  onManageRosters: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Horizon options"
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="w-[320px] p-3"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="Horizon options" placement="bottom">
          <button
            ref={ref}
            type="button"
            {...triggerProps}
            onClick={togglePopover}
            aria-label="Horizon options"
            className={`interactive inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-md" aria-hidden="true">
              <circle cx="4" cy="8" r="1.2" fill="currentColor" />
              <circle cx="8" cy="8" r="1.2" fill="currentColor" />
              <circle cx="12" cy="8" r="1.2" fill="currentColor" />
            </svg>
          </button>
        </Tooltip>
      )}
    >
      <div className="flex flex-col gap-3">
        <PolicyControl label="After a step finishes">
          <SegmentedControl
            ariaLabel="After a step finishes"
            value={policy.advance}
            onChange={(value) => onChange({ advance: value as RoadmapPolicy['advance'] })}
            items={[
              { value: 'approve', label: 'Ask me first' },
              { value: 'auto', label: 'Start the next' },
            ]}
          />
        </PolicyControl>
        <PolicyControl label="Merging delivered work">
          <SegmentedControl
            ariaLabel="Merging delivered work"
            value={policy.merge}
            onChange={(value) => onChange({ merge: value as RoadmapPolicy['merge'] })}
            items={[
              { value: 'manual', label: 'I merge' },
              { value: 'auto', label: 'Automatic' },
            ]}
          />
        </PolicyControl>
        {/* MC-1882: the label says SCOPE. This is the default for steps that do
            not override it, not a hard setting for the whole horizon. */}
        <PolicyControl label="Default roster">
          <RosterMenu
            rosters={rosters}
            selectedName={policy.roster ?? null}
            onSelect={(name) => onChange({ roster: name })}
            onManageRosters={() => {
              setOpen(false)
              onManageRosters()
            }}
          />
        </PolicyControl>
      </div>
    </Popover>
  )
}

function PolicyControl({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-[color:var(--text-muted)]">{label}</span>
      {children}
    </div>
  )
}

// Autosave's readout — the thing that replaced the edit mode. A state, not a
// button, except when a save has actually failed and there is something to retry.
function SavedIndicator({
  state,
  onRetry,
}: {
  state: 'saved' | 'saving' | 'pending' | 'failed'
  onRetry: () => void
}): JSX.Element {
  if (state === 'failed') {
    return (
      <GhostButton onClick={onRetry} aria-label="Retry saving the plan">
        Couldn’t save — try again
      </GhostButton>
    )
  }
  return (
    <span aria-live="polite" className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-subtle)]">
      {state === 'saved' ? (
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path
            d="M3.5 8.4 6.4 11.3 12.5 5.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      {/* An edit waiting out the debounce has NOT been written yet, so it says
          so — "Saving…" over a pending edit is a small lie about durability. */}
      {state === 'saving' ? 'Saving…' : state === 'pending' ? 'Unsaved edits…' : 'Saved'}
    </span>
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
