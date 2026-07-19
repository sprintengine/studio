// The roadmap steering board (MC-1620 / T7): the surface a human uses to see what
// ran, what's running, what's next, and what's waiting on them across a multi-week
// roadmap — and to act (approve, pause, resume, merge, skip) by exception. It is a
// workspace-mode panel, searchable like the roster/kanban board.
//
// Every control is a file/store write the orchestrator reconciles against, never an
// imperative side-channel: approve/pause/resume/merge write orchestrator state
// through the `roadmap:*` IPC; skip edits the roadmap markdown; "Edit plan" opens
// the authoring editor. The board itself reconciles against disk — it re-derives
// from the roadmap files + backlog + orchestrator sidecar on every refresh, so a
// kill/restart renders the identical board.

import React, { useCallback, useRef, useState } from 'react'

import type { WorkspacePanelProps } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog, Section } from '../ui'
import { revealNavRailComponent } from '../../utils/modelRegistry'
import { dispatchBacklogReveal } from '../../utils/backlogReveal'
import { joinFilePath } from '../../utils/paths'
import { skipRoadmapEntry } from '../../../../shared/sprintengine/roadmap-surface'
import type { RoadmapBoardUnit } from '../../../../shared/sprintengine/roadmap-surface'
import { useRoadmapBoard, type LoadedRoadmap } from './roadmapBoard/roadmapBoardData'
import { RoadmapLaneColumn, type RoadmapLaneCallbacks } from './roadmapBoard/RoadmapLaneColumn'
import { RoadmapWaitingOnYou, collectRoadmapInbox } from './roadmapBoard/RoadmapWaitingOnYou'

export default function RoadmapBoardPanel({ workspaceId }: WorkspacePanelProps): JSX.Element {
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
  )
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace)
  const { roadmaps, loading, error, reload } = useRoadmapBoard(folderPath)
  const dialog = useConfirmDialog()
  const [busyLane, setBusyLane] = useState<string | null>(null)
  const laneRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

  // Run a lane command, hold its controls busy while it is in flight, then re-read
  // the board so the new orchestrator state shows immediately.
  const runLaneCommand = useCallback(
    async (lane: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
      setBusyLane(lane)
      try {
        const result = await action()
        if (!result.ok && result.message) {
          await dialog.confirm({
            title: 'That action could not complete',
            body: result.message,
            confirmLabel: 'OK',
          })
        }
      } finally {
        setBusyLane(null)
        reload()
      }
    },
    [dialog, reload],
  )

  const commandInput = useCallback(
    (roadmapRef: string, lane: string) => ({ workspaceRoot: folderPath ?? '', roadmapRef, lane }),
    [folderPath],
  )

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

  // Skip removes the step from the roadmap file (the source of truth). It requires
  // a reason and a confirmation, then writes the edited markdown; the orchestrator
  // advances past the removed step on its next reconcile.
  const handleSkip = useCallback(
    async (roadmap: LoadedRoadmap, lane: string, unit: RoadmapBoardUnit) => {
      if (!folderPath) return
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
        const absolute = joinFilePath(folderPath, roadmap.roadmapRef)
        const content = await window.api.readfile(absolute)
        const next = skipRoadmapEntry(content, unit.ref, reason.trim(), new Date().toISOString().slice(0, 10))
        if (next !== content) {
          await window.api.writefile(absolute, next)
        } else {
          // The ref wasn't found in the file — never let a skip fail silently
          // after the user typed a required reason and confirmed.
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
    [folderPath, dialog, reload],
  )

  // Open the roadmap file in the Backlog editor (the T4 authoring UI) to reorder,
  // split/merge tracks, or add steps — the file stays the source of truth.
  const handleEditPlan = useCallback(
    (roadmapRef: string) => {
      revealNavRailComponent(workspaceId, 'backlog', 'Backlog')
      dispatchBacklogReveal({ workspaceId, relativePath: roadmapRef })
    },
    [workspaceId],
  )

  // Focus the running sprint's own workspace, when it is open. Autonomous runs may
  // not be mounted as a workspace; in that case the chip is simply inert (there is
  // nowhere to navigate to), never a broken link.
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

  const inbox = collectRoadmapInbox(roadmaps)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[color:var(--bg-canvas)]">
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-default)] px-4 py-2.5">
        <h2 className="text-[14px] font-semibold text-[color:var(--text-strong)]">Roadmap</h2>
        <span className="text-[12px] text-[color:var(--text-muted)]">
          {roadmaps.length === 1 ? '1 roadmap' : `${roadmaps.length} roadmaps`}
        </span>
        <button
          type="button"
          onClick={reload}
          className="interactive ml-auto rounded border border-[color:var(--border-default)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
        >
          Refresh
        </button>
      </header>

      {error ? (
        <div className="border-b border-[color:var(--border-default)] px-4 py-2 text-[12px] text-[color:var(--tone-warn)]">
          Could not read your roadmaps: {error}
        </div>
      ) : null}

      {inbox.length > 0 ? (
        <div className="shrink-0 border-b border-[color:var(--border-default)]">
          <Section title="Waiting on you" count={inbox.length} level={3} inset={false}>
            <RoadmapWaitingOnYou entries={inbox} onSelect={handleSelectInbox} />
          </Section>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {roadmaps.length === 0 ? (
          <RoadmapBoardEmptyState loading={loading} />
        ) : (
          <div className="flex flex-col gap-6">
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
                  <h3 className="mb-2 text-[13px] font-semibold text-[color:var(--text-default)]">{roadmap.title}</h3>
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
                          folderPath={folderPath}
                          callbacks={callbacks}
                          onReloadBoard={reload}
                        />
                      </div>
                    ))}
                    {roadmap.lanes.length === 0 ? (
                      <p className="text-[12px] text-[color:var(--text-muted)]">
                        This roadmap has no tracks yet. Open it in the Backlog to add some.
                      </p>
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

function RoadmapBoardEmptyState({ loading }: { loading: boolean }): JSX.Element {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
        Loading roadmaps…
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
      <span className="text-[13px] font-semibold text-[color:var(--text-strong)]">No roadmaps yet</span>
      <span className="max-w-sm text-[12px] leading-5 text-[color:var(--text-muted)]">
        A roadmap is an ordered plan an orchestrator works for you. Create one from the Backlog, then
        watch its progress and steer it here.
      </span>
    </div>
  )
}
