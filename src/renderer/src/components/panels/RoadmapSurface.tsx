// The instance-global Roadmap surface (MC-1689): one plan per Multicode, opened
// from the sidebar door. Unlike the retired per-project roadmap workspace mode, this
// surface is a store-level singleton overlay (the Connectors precedent, exactly): it
// self-gates on `roadmapSurface.open`, traps focus, and closes on Escape / scrim.
//
// It never lands on a dead end. With no roadmap yet, the blank area IS the creation
// flow — a pitch and one "Plan your roadmap" button that picks the home project (D1),
// creates the instance roadmap, and drops the user into planning. With a roadmap, it
// shows the steering board: the waiting-on-you strip on top, then each track's
// controls (Start next / Approve & merge / Pause / Resume / Skip) — every one a
// file/store write the orchestrator reconciles against, never an imperative
// side-channel. Steps carry a project tag because one plan now spans projects.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { RoadmapBoardUnit } from '../../../../shared/sprintengine/roadmap-surface'
import { skipRoadmapEntry } from '../../../../shared/sprintengine/roadmap-surface'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { CloseIconButton, Section, useConfirmDialog } from '../ui'
import { newRoadmapFileContent } from '../backlog/roadmapAuthoring'
import { backlogRootPath, normalizeRelativePath } from '../../utils/backlog'
import { basename, joinFilePath, samePath, slugify } from '../../utils/paths'
import { revealNavRailComponent } from '../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../utils/backlogReveal'
import { useRoadmapBoard, type LoadedRoadmap } from './roadmapBoard/roadmapBoardData'
import { RoadmapLaneColumn, type RoadmapLaneCallbacks } from './roadmapBoard/RoadmapLaneColumn'
import { RoadmapPlannerView } from './roadmapBoard/RoadmapPlannerView'
import { RoadmapWaitingOnYou, collectRoadmapInbox } from './roadmapBoard/RoadmapWaitingOnYou'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Stable no-op close for the embedded (workspace-tab) mount, where there is no
// overlay to dismiss — keeps the board's nav handlers reference-stable.
const NO_CLOSE = (): void => {}

// The store-level overlay shell: backdrop, Escape, focus capture + restore,
// scroll-lock. Renders nothing when closed, and only mounts the board body (which
// polls orchestrator state) while open — a mirror of ConnectorsSurface.
export default function RoadmapSurface(): JSX.Element | null {
  const open = useWorkspaceStore((s) => s.roadmapSurface.open)
  const closeRoadmapSurface = useWorkspaceStore((s) => s.closeRoadmapSurface)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => {
      const node = surfaceRef.current
      if (node && !node.contains(document.activeElement)) node.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRoadmapSurface()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target && document.contains(target)) target.focus()
    }
  }, [open, closeRoadmapSurface])

  if (!open) return null

  const trapFocus = (position: 'start' | 'end') => () => {
    const root = surfaceRef.current
    if (!root) return
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute('data-focus-sentinel'),
    )
    if (focusables.length === 0) {
      root.focus()
      return
    }
    if (position === 'start') focusables[focusables.length - 1].focus()
    else focusables[0].focus()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Roadmap"
      className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center p-4 outline-none sm:p-8 lg:p-12"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRoadmapSurface()
      }}
    >
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('start')} className="sr-only" />
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex h-full max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[1080px] flex-col overflow-hidden rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        <RoadmapBoard onClose={closeRoadmapSurface} />
      </div>
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('end')} className="sr-only" />
    </div>
  )
}

// The instance-global board: the read plus the steering handlers, the waiting-on-you
// strip, and the empty-state creation flow. Rendered inside the overlay above (with
// `onClose`), and — until the roadmap workspace mode is retired (T5) — directly in a
// workspace tab (no `onClose`, so no close affordance). One implementation, two
// mounts. It polls orchestrator state only while mounted.
export function RoadmapBoard({ onClose }: { onClose?: () => void }): JSX.Element {
  const close = onClose ?? NO_CLOSE
  const { roadmaps, loading, error, homePath, reload } = useRoadmapBoard()
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  // Distinct project count for the empty-state pitch ("all N projects").
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
  const [creating, setCreating] = useState(false)
  // The roadmap file being planned in the in-surface cross-project planner (T3), or
  // null when the steering board is showing. Planning happens here now — no detour
  // to a single project's Backlog panel.
  const [planningRef, setPlanningRef] = useState<string | null>(null)
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

  // Instance-global: a command carries only the roadmap file + lane; the main driver
  // derives the home project (D1).
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

  // Skip removes the step from the roadmap file (the source of truth), which lives in
  // the home project. Requires a reason and a confirmation, then writes the edited
  // markdown; the orchestrator advances past the removed step on its next reconcile.
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

  // Reveal a backlog file in its project's Backlog panel (the planner's "open the
  // file" and per-step "go to item" affordances). Cross-project safe: the item may
  // live in any project, so it routes to that project's workspace when open, and
  // otherwise leaves the surface in place rather than mounting a Backlog panel that
  // cannot exist.
  const openPlanning = useCallback(
    (projectRoot: string, relativePath: string) => {
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((candidate) => samePath(candidate.folderPath, projectRoot))
      if (!workspace) return
      setActiveWorkspace(workspace.id)
      close()
      revealNavRailComponent(workspace.id, 'backlog', 'Backlog')
      dispatchBacklogReveal({ workspaceId: workspace.id, relativePath })
    },
    [close, setActiveWorkspace],
  )

  // Plan the roadmap in the in-surface cross-project planner (T3): the library rail
  // pulls from every project, and edits round-trip through the one instance roadmap
  // file. The Backlog ⋯ overflow menu is never the door.
  const handleEditPlan = useCallback((roadmapRef: string) => setPlanningRef(roadmapRef), [])

  // Focus the running sprint's own workspace, when it is open. Autonomous runs may not
  // be mounted as a workspace; the chip is then inert, never a broken link.
  const handleOpenRun = useCallback(
    (statePath: string) => {
      const workspace = useWorkspaceStore
        .getState()
        .workspaces.find((candidate) => candidate.sprintEngineContext?.statePath === statePath)
      if (workspace) {
        setActiveWorkspace(workspace.id)
        close()
      }
    },
    [close, setActiveWorkspace],
  )

  const handleSelectInbox = useCallback((roadmapRef: string, lane: string) => {
    const node = laneRefs.current.get(`${roadmapRef}:${lane}`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [])

  // The empty-state creation flow: pick the home project (D1), create the instance
  // roadmap in it, and drop into planning. The home project is where the roadmap FILE
  // lives; the plan can still pull work from every project. We name the choice in the
  // prompt rather than guessing silently.
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
        title: 'Plan your roadmap',
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
      // Write the roadmap file FIRST, then set the home project (D1). Ordering
      // matters: `setRoadmapHomeProject` triggers a reconcile, so writing the file
      // before it means that reconcile already sees the new roadmap and begins
      // orchestrating it — rather than reconciling an empty home.
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
      reload()
      // Drop straight into the in-surface planner on the new file (D1: the file
      // lives in the home project, but the plan spans every project).
      setPlanningRef(normalizeRelativePath(`backlog/roadmaps/${fileName}`))
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

  const inbox = collectRoadmapInbox(roadmaps)
  const spansProjects = roadmaps.some((roadmap) => roadmap.roadmap.projects.length > 0)
  const summary = deriveRoadmapSummary(roadmaps)
  const hasRoadmap = roadmaps.length > 0

  // The cross-project planner takes over the whole surface while editing a plan; its
  // own header carries Back (to this board) and Save. Escape still closes the surface.
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-subtle)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[color:var(--text-strong)]">Roadmap</h2>
        <span className="text-[12px] text-[color:var(--text-subtle)]">{summary}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {hasRoadmap ? (
            <button
              type="button"
              onClick={reload}
              className="interactive rounded border border-[color:var(--border-default)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
            >
              Refresh
            </button>
          ) : null}
          {onClose ? <CloseIconButton onClick={onClose} aria-label="Close roadmap" /> : null}
        </div>
      </header>

      {error ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-4 py-2 text-[12px] text-[color:var(--tone-warn)]">
          Could not read your roadmap: {error}
        </div>
      ) : null}

      {inbox.length > 0 ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)]">
          <Section title="Waiting on you" count={inbox.length} level={3} inset={false}>
            <RoadmapWaitingOnYou entries={inbox} onSelect={handleSelectInbox} />
          </Section>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {!hasRoadmap ? (
          <RoadmapEmptyState
            loading={loading}
            creating={creating}
            projectCount={projectCount}
            onCreate={() => void handleCreateRoadmap()}
          />
        ) : (
          <div className="flex flex-col gap-6 p-4">
            {roadmaps.map((roadmap) => {
              const callbacks: RoadmapLaneCallbacks = {
                onApprove: (lane) => handleApprove(roadmap.roadmapRef, lane),
                onPause: (lane) => void handlePause(roadmap.roadmapRef, lane),
                onResume: (lane) => handleResume(roadmap.roadmapRef, lane),
                onMerge: (lane) => handleMerge(roadmap.roadmapRef, lane),
                onSkip: (lane, unit) => void handleSkip(roadmap, lane, unit),
                onEditPlan: () => handleEditPlan(roadmap.roadmapRef),
                onOpenRun: handleOpenRun,
                busyLane,
              }
              return (
                <section key={roadmap.roadmapRef} aria-label={`Roadmap: ${roadmap.title}`}>
                  {roadmaps.length > 1 ? (
                    <h3 className="mb-2 text-[13px] font-semibold text-[color:var(--text-default)]">{roadmap.title}</h3>
                  ) : null}
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
                    {roadmap.lanes.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => handleEditPlan(roadmap.roadmapRef)}
                        className="interactive rounded-md border border-dashed border-[color:var(--border-default)] px-4 py-6 text-[12px] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-focus)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                      >
                        No steps yet — plan this roadmap
                      </button>
                    ) : null}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// "Step X of Y · N projects" across the plan, or a plain state when nothing is
// planned — the header's at-a-glance line (mockup §2). Truthful over the real board
// model: done and total come from the lanes, projects from the distinct step tags.
function deriveRoadmapSummary(roadmaps: ReadonlyArray<LoadedRoadmap>): string {
  if (roadmaps.length === 0) return 'Nothing planned'
  let done = 0
  let total = 0
  const projects = new Set<string>()
  for (const roadmap of roadmaps) {
    for (const lane of roadmap.lanes) {
      done += lane.doneCount
      total += lane.total
      for (const unit of lane.units) projects.add(unit.projectName)
    }
  }
  if (total === 0) return 'Nothing planned yet'
  const step = Math.min(done + 1, total)
  const projectLabel = `${projects.size} project${projects.size === 1 ? '' : 's'}`
  return `Step ${step} of ${total} · ${projectLabel}`
}

// The empty state carries the one next step, never a dead end (mockup §1). It is the
// creation flow: the pitch plus a single "Plan your roadmap" button.
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
      <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">Plan what runs while you sleep</h3>
      <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
        Line up backlog work from any project in order. Multicode runs it sprint by sprint — you approve, merge, and
        step in only when it asks.
      </p>
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="interactive mt-1 inline-flex items-center gap-1.5 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--text-on-accent)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
      >
        {creating ? 'Creating…' : 'Plan your roadmap'}
      </button>
      {projectCount > 0 ? (
        <span className="mt-3 text-[11px] text-[color:var(--text-subtle)]">
          Pulls from the backlogs of {projectCount === 1 ? 'this project' : `all ${projectCount} projects`} in this
          Multicode.
        </span>
      ) : (
        <span className="mt-3 text-[11px] text-[color:var(--text-subtle)]">Open a project to plan a roadmap.</span>
      )}
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

function todayPrefix(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
