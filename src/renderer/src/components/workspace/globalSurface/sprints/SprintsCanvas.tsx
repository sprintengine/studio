// The Sprints door's canvas (item 1764, mockup §2): the selected run, top to
// bottom — the repositories it declares, the run rollup, then its full board.
// Everything here reads the run's own projection through the statePath handle
// (item 1762), so a historical run whose workspace is long gone opens exactly like
// a live one; only workspace-bound actions (open the agents' terminals) degrade,
// and they say why.
//
// Refresh ownership (plan D3): a run whose workspace is resident is refreshed by
// that workspace's projection supervisor, and this canvas reads the workspace's
// state directly rather than opening a second reader. A run with NO resident
// workspace gets exactly one statePath-keyed refresh driver — mounted here, for
// the selected run only, and only while that run is still live.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import type {
  SprintEngineState,
  SprintEngineTask,
  SprintEngineVcsRepo,
} from '../../../../../../shared/sprintengine/run-types'
import {
  deriveRepoMergeBlockers,
  type RepoMergeBlockers,
} from '../../../../../../shared/sprintengine/roadmap-surface'
import {
  buildSprintEngineAgentRosterForState,
  deriveSprintEngineRepoMergeRollup,
  getSprintEngineRoleLabel,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  sprintEngineHumanInputTasks,
  type SprintEngineRepoMergeRollup,
} from '../../../../utils/sprintengine'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
// The handle helpers come from the store slice, and the board itself is lazy: the
// board module is the heaviest in the renderer, and the door must open on the
// repositories strip and the rollup without waiting for it. `SprintRunBoard.tsx`
// stays the door's import site for the component (item 1762's seam).
import {
  normalizeStatePathKey,
  sprintRunHandleFromWorkspace,
  useSprintRunEntry,
  useSprintRunHandleFromStatePath,
  useSprintRunStore,
  type SprintRunHandle,
} from '../../../../store/sprintRunStoreSlice'
import { useSprintEngineViewStore } from '../../../../store/sprintEngineViewStore'
import { useSprintEngineTokenUsage } from '../../../../hooks/useSprintEngineTokenUsage'
import {
  describeTokenCoverage,
  formatTokenCount,
  tokenReportHasAgents,
} from '../../../../utils/sprintengineTokenUsage'
import { dispatchRevealTarget } from '../../../../utils/revealTarget'
import { publishDiagnosticSync } from '../../../../utils/diagnostics'
import {
  DefinitionList,
  GhostButton,
  OverflowMenu,
  Popover,
  PrimaryButton,
  Spinner,
  TruncatedText,
  useConfirmDialog,
  type DefinitionItem,
  type OverflowMenuItem,
} from '../../../ui'
import { SuspenseFallback } from '../../../ui/SuspenseFallback'
import { createProjectionPollLoop } from '../../SprintEngineProjectionSupervisor'
import { BarStatusChip, SurfaceCanvasState } from '../surfaceSubstrate'
import {
  repoDisplayName,
  repoIsMergeable,
  repoPullRequestState,
  useRepoMergeAction,
  type RepoMergeAction,
} from '../../../panels/sprintEngineBoard/repoMergeSurface'
import { sprintRunOpenFailureCopy, sprintRunShortDate } from './railState'
import { requestCloseSprintWorkspace } from './sprintDoorRequests'
import { deleteSprintRun } from './sprintRunDeletion'
import { SprintsRepoStrip } from './SprintsRepoStrip'

const SprintRunBoard = React.lazy(async () => ({
  default: (await import('../../../panels/SprintRunBoard')).SprintRunBoard,
}))

// The same cadence the workspace projection supervisor uses. The read
// short-circuits on an mtime:size token, so an unchanged projection costs one
// stat() — this is the run's only reader while the door owns it.
const DOOR_PROJECTION_POLL_MS = 4000

export type SprintRunCanvasModel = {
  run: SprintRunSummary
  statePath: string
  /** Null until the projection has been read (or when it could not be). */
  handle: SprintRunHandle | null
  state: SprintEngineState | null
  status: 'loading' | 'ready' | 'error'
  /** Why the projection could not be read. Shown behind "Show details". */
  error: string | null
  retry: () => void
  /** The run's own workspace, when it is still open in this Multicode. */
  residentWorkspaceId: string | null
  repos: SprintEngineVcsRepo[]
  blockers: RepoMergeBlockers
  rollup: SprintEngineRepoMergeRollup | null
  completed: boolean
  canceled: boolean
  /** Completed AND every declared repo merged (plan D10) — never the flat PR state. */
  landed: boolean
  humanInputTasks: SprintEngineTask[]
  /** Repos whose pull request can be merged right now (open, nothing in its way). */
  mergeable: SprintEngineVcsRepo[]
  /**
   * The run's ONE merge action, shared by the repositories strip and the bar's
   * next-step button — so a merge started from either place reports its progress
   * and the engine's refusal in one place: the card for the repo it targeted.
   */
  merge: RepoMergeAction
}

/**
 * Resolve the selected run into everything the bar and the canvas need. One hook
 * so the two can never disagree about the run they are describing. Returns null
 * with nothing selected — the surface still calls it unconditionally, so the
 * refresh driver tears down cleanly when the selection clears.
 */
export function useSprintRunCanvas(run: SprintRunSummary | null): SprintRunCanvasModel | null {
  const statePath = run?.statePath ?? ''
  const statePathKey = normalizeStatePathKey(statePath)
  // The run's own workspace, if it is still open. Selected as an id (a primitive)
  // so an unrelated workspace-store write cannot re-render the canvas.
  const residentWorkspaceId = useWorkspaceStore(
    (store) =>
      store.workspaces.find(
        (workspace) =>
          workspace.sprintEngineContext?.statePath
          && normalizeStatePathKey(workspace.sprintEngineContext.statePath) === statePathKey,
      )?.id ?? null,
  )
  const residentWorkspace = useWorkspaceStore((store) =>
    residentWorkspaceId ? store.workspaces.find((w) => w.id === residentWorkspaceId) ?? null : null,
  )
  const applyWorkspaceState = useWorkspaceStore((store) => store.setSprintEngineState)
  const workspaceHandle = useMemo(
    () => (residentWorkspace ? sprintRunHandleFromWorkspace(residentWorkspace, applyWorkspaceState) : null),
    [residentWorkspace, applyWorkspaceState],
  )

  // Read from disk only when no resident workspace already holds this run's
  // state: passing null keeps the run-store slice from opening a second copy.
  const pathHandle = useSprintRunHandleFromStatePath(
    workspaceHandle ? null : statePath || null,
    workspaceHandle ? undefined : run?.teamSlug,
  )
  const entry = useSprintRunEntry(workspaceHandle ? null : statePath)
  const refreshRun = useSprintRunStore((store) => store.refreshRun)
  const retry = useCallback(() => void refreshRun(statePath), [refreshRun, statePath])
  // One merge action for the run, wherever it is started from.
  const merge = useRepoMergeAction({ statePath, onMerged: retry })

  // Browsing the rail opens one run after another, and each door-read run holds a
  // whole projection in the run store. Release the previous one when the selection
  // moves on, so a long session over many runs does not accumulate them; coming
  // back costs one cheap (mtime-short-circuited) read.
  const closeRun = useSprintRunStore((store) => store.closeRun)
  const previousStatePath = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousStatePath.current
    previousStatePath.current = statePath || null
    if (previous && previous !== statePath) closeRun(previous)
  }, [statePath, closeRun])

  const handle = workspaceHandle ?? pathHandle
  const state = handle?.sprintEngineState ?? null
  const completed = Boolean(state && isCompletedSprintEngineRun(state))
  const canceled = Boolean(state && isCanceledSprintEngineRun(state))

  // The single refresh driver (D3). It exists only for a run the door alone is
  // reading, and only while that run can still change — a completed or canceled
  // run is terminal, and a resident workspace already has its own supervisor.
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined)
  refreshRef.current = pathHandle?.refresh
  // A projection that could not be read does not heal by re-reading it (the run
  // store is gone, or this build cannot read it) — the workspace supervisor skips
  // those for the same reason. The canvas shows the failure with "Try again", so
  // recovery stays explicit instead of a 4 s loop against a missing file.
  const shouldPoll =
    residentWorkspaceId === null && !completed && !canceled && entry?.status !== 'error'
  useEffect(() => {
    if (!shouldPoll || !statePath) return
    const loop = createProjectionPollLoop({
      cadenceMs: DOOR_PROJECTION_POLL_MS,
      runTick: () => refreshRef.current?.(),
    })
    loop.sync(true)
    return () => loop.dispose()
  }, [shouldPoll, statePath])

  const status: SprintRunCanvasModel['status'] = state
    ? 'ready'
    : entry?.status === 'error'
      ? 'error'
      : 'loading'

  return useMemo(() => {
    if (!run) return null
    const repos = state?.vcs?.repos ?? []
    const rollup = deriveSprintEngineRepoMergeRollup(state?.vcs)
    const blockers = deriveRepoMergeBlockers(state?.tasks ?? [], repos)
    return {
      run,
      statePath,
      handle,
      state,
      status,
      // A run the index itself could not read carries its own reason; prefer it
      // over a generic one so the canvas never invents why.
      error: entry?.error ?? run.unknownReason ?? null,
      retry,
      residentWorkspaceId,
      repos,
      blockers,
      rollup,
      completed,
      canceled,
      landed: completed && Boolean(rollup?.allMerged),
      humanInputTasks: state ? sprintEngineHumanInputTasks(state) : [],
      mergeable: repos.filter((repo) => repoIsMergeable(repo, blockers)),
      merge,
    }
  }, [run, statePath, handle, state, status, entry?.error, retry, residentWorkspaceId, completed, canceled, merge])
}

// ── The canvas ───────────────────────────────────────────────────────────────

export function SprintsCanvas({ model }: { model: SprintRunCanvasModel }): JSX.Element {
  if (model.status === 'loading') {
    return <SurfaceCanvasState kind="loading" label={`Loading ${model.run.teamName}…`} />
  }
  if (model.status === 'error' || !model.handle) {
    // A store from an older Multicode fails permanently and says so, with its
    // delete path in the details — the one place that remedy is spelled out
    // (MC-2063). Everything else keeps the transient-read copy.
    const copy = sprintRunOpenFailureCopy(model.run)
    return (
      <SurfaceCanvasState
        kind="error"
        title={copy.title}
        hint={copy.hint}
        detail={model.error ?? undefined}
        onRetry={model.retry}
        retryLabel={copy.retryLabel}
      />
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The run's board and nothing above it (owner, 2026-07-30). The summary
          sentence that used to sit here was a third band of chrome under the app
          strip and the door bar — and every fact in it (what is waiting, who is
          working, what has merged) is a column of the board one tab away. One
          chrome row per region: the tab row is that row. */}
      <div className="min-h-0 flex-1">
        <React.Suspense fallback={<SuspenseFallback label="Loading the board" />}>
          <SprintRunBoard
            handle={model.handle}
            reposTab={{
              count: model.repos.length > 0 ? model.repos.length : undefined,
              render: () => (
                <div className="flex flex-col gap-4 px-5 py-4">
                  {model.repos.length > 0 ? (
                    <SprintsRepoStrip
                      repos={model.repos}
                      tasks={model.state?.tasks ?? []}
                      blockers={model.blockers}
                      projectRoot={model.run.projectRoot}
                      merge={model.merge}
                    />
                  ) : (
                    <p className="text-meta text-[color:var(--text-muted)]">
                      This sprint works in the project directly — no separate branches to track.
                    </p>
                  )}
                  <RunRollupPanel model={model} />
                </div>
              ),
            }}
          />
        </React.Suspense>
      </div>
    </div>
  )
}

// The run rollup (mockup §2 "Run"): the four facts that answer "where is this
// run?" without reading the board — how much work is done, who is on it, whether
// it has landed, and what it was started from.
function RunRollupPanel({ model }: { model: SprintRunCanvasModel }): JSX.Element {
  const { state } = model
  const tasks = state?.tasks ?? []
  const done = tasks.filter((task) => task.status === 'done').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress' || task.status === 'review').length
  const waiting = tasks.filter((task) => task.status === 'todo' || task.status === 'needs_input').length
  const roster = buildSprintEngineAgentRosterForState(state)
  const working = roster.filter((member) => {
    const worker = state?.workers?.[member.id] ?? state?.sprintEngineAgents?.[member.id]
    return worker?.status === 'running'
  }).length
  const started = sprintRunShortDate(model.run.startedAt)

  // One chip in the panel, on the row whose state is not already obvious from
  // its own words: landing. The task counts, the roster, and the seed each read
  // their state in the line itself — a second dot beside them would only invite
  // the two to look like they disagree.
  const landed = landedChip(model)
  const items: DefinitionItem[] = [
    {
      term: 'Tasks',
      description:
        tasks.length === 0
          ? 'No tasks planned yet'
          : `${done} done · ${inProgress} in progress · ${waiting} waiting`,
    },
    {
      term: 'Agents',
      description: rosterLine(
        // A role names the agent when it has one; an agent with none is named
        // by its own row label, which is its id (MC-2055). Never "Unknown
        // role", which is what the accessor says about an id it cannot
        // resolve — absence is known.
        roster.map((member) => (member.role ? getSprintEngineRoleLabel(member.role) : member.label)),
        working,
        // Why "Open agents" is disabled, in plain sight rather than on hover:
        // the run's terminals live in its workspace, and that workspace is gone.
        model.residentWorkspaceId === null,
      ),
    },
    {
      term: 'Landed',
      description: landed ? (
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1">{landedLine(model)}</span>
          <span className="shrink-0">{landed}</span>
        </span>
      ) : (
        landedLine(model)
      ),
    },
    ...(model.run.sourceLabel
      ? [
          {
            term: 'Started from',
            description: [model.run.sourceLabel, sourceLine(model)].filter(Boolean).join(' · '),
          },
        ]
      : []),
    ...(started ? [{ term: 'Started', description: started }] : []),
  ]

  // The kit's label / value rows, so this frame and Automations' definition
  // facts align on one term column and one type step rather than a private
  // `w-[92px]` column and hairline rows of their own.
  return (
    <section
      className="flex flex-col rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2"
      aria-label="Run"
    >
      <DefinitionList items={items} />
    </section>
  )
}

// "architect, developer ×2 — 1 working" / "— all idle" / "— workspace closed, so
// no terminals are running". Counts the seats the run actually has; a run whose
// roster has not been seated yet says so rather than printing an empty list.
function rosterLine(roleLabels: string[], working: number, workspaceClosed: boolean): string {
  const state = workspaceClosed
    ? 'workspace closed, so no terminals are running'
    : working > 0
      ? `${working} working`
      : 'all idle'
  if (roleLabels.length === 0) {
    return workspaceClosed ? `No agents on this run — ${state}` : 'No agents on this run yet'
  }
  const counts = new Map<string, number>()
  for (const label of roleLabels) counts.set(label, (counts.get(label) ?? 0) + 1)
  const roles = [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(', ')
  return `${roles} — ${state}`
}

// Landing is the multi-repo truth (D10): completed is not landed until every
// declared branch has merged, and the line names what is still out — by project
// when exactly one leg remains, because "the last branch" is not an answer to
// "which one?".
function landedLine(model: SprintRunCanvasModel): string {
  if (model.canceled) return 'This sprint was canceled'
  if (!model.rollup) return 'This sprint works in the project directly — nothing to merge'
  if (model.rollup.allMerged) return 'Every branch has merged'
  // State first, and never the self-contradicting "0 of 0 merged — the work
  // isn't finished yet": a run with no branches pushed yet says that.
  if (model.rollup.total === 0) return 'No branches pushed yet'
  const counted = `${model.rollup.merged} of ${model.rollup.total} merged`
  if (!model.completed) {
    return model.rollup.merged === 0
      ? 'Nothing merged yet — the run is still working'
      : `${counted} — the rest lands as the run finishes`
  }
  const out = model.repos.filter(
    (repo) =>
      repoPullRequestState(repo) !== 'merged' && (repo.pullRequestUrl || repo.lastCommitSha),
  )
  const last = model.rollup.unmerged === 1 && out.length === 1 ? out[0] : null
  return last
    ? `Lands when ${repoDisplayName(last, model.run.projectRoot)} merges (${counted})`
    : `Lands when the remaining branches merge (${counted})`
}

function landedChip(model: SprintRunCanvasModel): React.ReactNode {
  if (model.canceled) return <BarStatusChip tone="neutral" label="Canceled" />
  if (model.landed) return <BarStatusChip tone="merged" label="Landed" />
  if (!model.rollup) return null
  const left = model.rollup.unmerged
  return <BarStatusChip tone="warn" label={left === 1 ? '1 leg open' : `${left} legs open`} />
}

// The seed document's own name, beside its kind ("Epic · post-merge-hardening").
// Empty when the run records only a kind, so the row never says "Epic · Epic".
function sourceLine(model: SprintRunCanvasModel): string {
  const path = model.state?.source?.path
  if (!path) return ''
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.replace(/\.[^.]+$/u, '')
}

// ── The surface bar's actions ────────────────────────────────────────────────

/**
 * The bar's trailing controls (mockup §2): the two quiet readouts — jump to the
 * run's agents, read its token usage — the ONE next-step action, and the
 * overflow that holds the run's disposal.
 *
 * The next step is the thing the RUN is waiting on a person for: answer a
 * question, or merge what is left. When the run is simply working there is no
 * next step and the slot stays empty rather than promoting a destructive action
 * into the accent primary — cancelling lives with the board's other run-level
 * commands, where a destructive action belongs.
 */
export function SprintsBarActions({
  model,
  onRunDeleted,
}: {
  model: SprintRunCanvasModel
  /** The run's store was removed from disk: the surface drops it and re-reads. */
  onRunDeleted: () => void
}): JSX.Element {
  const setActiveWorkspace = useWorkspaceStore((store) => store.setActiveWorkspace)
  const setRunView = useSprintEngineViewStore((store) => store.setView)
  const merge = model.merge

  const openAgents = useCallback(() => {
    if (model.residentWorkspaceId) setActiveWorkspace(model.residentWorkspaceId)
  }, [model.residentWorkspaceId, setActiveWorkspace])

  // Send the board to the run's inbox and select the waiting task, through the
  // same reveal seam a notification's "Open" uses — no new deep-link channel.
  const resolveInput = useCallback(() => {
    const task = model.humanInputTasks[0]
    if (!task) return
    setRunView(model.statePath, 'inbox')
    dispatchRevealTarget({
      workspaceId: model.residentWorkspaceId ?? '',
      target: { kind: 'task', ref: task.id },
    })
  }, [model.humanInputTasks, model.residentWorkspaceId, model.statePath, setRunView])

  const waiting = model.humanInputTasks.length
  const unmerged = model.rollup && !model.rollup.allMerged ? model.rollup.unmerged : 0
  const nextMerge = model.mergeable[0] ?? null

  // A workspace-only action stays visible and disabled rather than vanishing, and
  // says why in its accessible name; the canvas repeats the reason in plain sight
  // on the Agents row, because a hover-only explanation is no explanation.
  return (
    <>
      <GhostButton
        onClick={openAgents}
        disabled={!model.residentWorkspaceId}
        aria-label={
          model.residentWorkspaceId
            ? undefined
            : 'Open agents — unavailable: this sprint’s workspace is closed, so its agent terminals aren’t running'
        }
      >
        Open agents
      </GhostButton>
      <TokenUsageAction model={model} />
      {waiting > 0 ? (
        <PrimaryButton onClick={resolveInput}>
          {waiting === 1 ? 'Resolve input' : `Resolve input · ${waiting}`}
        </PrimaryButton>
      ) : model.completed && unmerged > 0 ? (
        <PrimaryButton
          onClick={() => {
            if (nextMerge) {
              void merge.merge(nextMerge, repoDisplayName(nextMerge, model.run.projectRoot))
            }
          }}
          disabled={!nextMerge || merge.mergingRepoId !== null}
          aria-label={
            nextMerge
              ? undefined
              : `Merge remaining — unavailable: the ${unmerged === 1 ? 'branch' : 'branches'} still out have no open pull request`
          }
        >
          {merge.mergingRepoId ? 'Merging…' : `Merge remaining · ${unmerged}`}
        </PrimaryButton>
      ) : null}
      <SprintRunDisposalMenu model={model} onRunDeleted={onRunDeleted} />
    </>
  )
}

// The run's disposal, in the overflow rather than the bar: both actions are rare
// and one is irreversible, so neither earns a standing button beside the readouts
// the operator uses every visit.
//
// These are the two workflows the Projects row carried before sprints left it
// (item 1767). "Archive" did not come with them: archiving only ever hid a row
// from the Projects list and the retired Sprints aside, and there is no longer a
// row to hide — the door lists every run on disk, and the operator's way to stop
// seeing one is to delete it.
function SprintRunDisposalMenu({
  model,
  onRunDeleted,
}: {
  model: SprintRunCanvasModel
  onRunDeleted: () => void
}): JSX.Element {
  const dialog = useConfirmDialog()
  const [busy, setBusy] = useState(false)
  const runName = model.run.teamName

  const closeWorkspace = useCallback(async () => {
    const workspaceId = model.residentWorkspaceId
    if (!workspaceId) return
    const confirmed = await dialog.confirm({
      title: `Close the workspace for “${runName}”?`,
      body: 'Its agent terminals stop. The sprint itself is kept — it stays on this page, and you can read its board and history exactly as now.',
      confirmLabel: 'Close workspace',
      tone: 'danger',
    })
    // Nothing on disk follows a plain close, so this one does not wait on the
    // teardown it starts — the menu closes and the terminals stop behind it.
    if (confirmed) void requestCloseSprintWorkspace(workspaceId)
  }, [dialog, model.residentWorkspaceId, runName])

  // Type-to-confirm, the same bar the Projects row's "Delete workspace" set: this
  // takes away the run's whole record — its plan, its tasks, its evidence, its
  // review history — and the door is the only place it was listed. The folder
  // goes to the system trash, so the copy says that rather than claiming it is
  // unrecoverable.
  const runDirectory = sprintRunDirectory(model.statePath)
  const deleteRun = useCallback(async () => {
    if (!runDirectory) return
    const typed = await dialog.prompt({
      title: `Delete the sprint “${runName}”?`,
      body: 'Any running agents stop, and the sprint’s stored plan, tasks, and history move to your system trash. Committed work and branches are kept.',
      inputLabel: 'Type the sprint name to confirm',
      placeholder: runName,
      required: true,
      confirmLabel: 'Delete sprint',
      tone: 'danger',
      validate: (value) => (value.trim() === runName.trim() ? null : 'That is not the sprint name.'),
    })
    if (typed === null) return
    setBusy(true)
    try {
      // Teardown, trash, tombstone — one ordered sequence (item 1812), which is
      // why it lives in its own module rather than inline here.
      await deleteSprintRun({
        statePath: model.statePath,
        runDirectory,
        residentWorkspaceId: model.residentWorkspaceId ?? null,
      })
      onRunDeleted()
    } catch (error) {
      publishDiagnosticSync({
        level: 'error',
        source: 'sprintengine',
        title: 'Delete sprint failed',
        message: `“${runName}” is still on disk.`,
        details: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }, [dialog, runName, model.residentWorkspaceId, model.statePath, runDirectory, onRunDeleted])

  // "Close workspace" drops out entirely for a run with no workspace, rather than
  // sitting there greyed: there is nothing to close, the canvas already says so on
  // the Agents row, and the Projects row's own menu hid inapplicable actions the
  // same way. Delete stays visible but disabled when the run's folder could not be
  // resolved — an unexplained missing action reads as a bug.
  const items: OverflowMenuItem[] = []
  if (model.residentWorkspaceId) {
    items.push({
      id: 'close-workspace',
      label: 'Close workspace',
      disabled: busy,
      onSelect: () => void closeWorkspace(),
    })
    items.push({ kind: 'separator', id: 'sep-disposal' })
  }
  items.push({
    id: 'delete-run',
    label: busy ? 'Deleting…' : runDirectory ? 'Delete sprint…' : 'Delete sprint (its folder can’t be found)',
    destructive: true,
    disabled: busy || !runDirectory,
    onSelect: () => void deleteRun(),
  })

  // The delete in flight, on the bar rather than only in the menu. Selecting a
  // menu item closes the menu, so the "Deleting…" label above is never on screen
  // while the delete runs — and since the delete now waits for every one of the
  // run's terminals to die before the folder is trashed (item 1812), that is a
  // real wait with no signal: the operator types the sprint name, presses
  // Delete, and nothing changes for seconds. The live line is the same shape the
  // Reviews door uses for a run in flight.
  return (
    <>
      {busy ? (
        <span
          role="status"
          className="flex shrink-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]"
        >
          <Spinner />
          Deleting…
        </span>
      ) : null}
      <OverflowMenu ariaLabel={`More actions for ${runName}`} triggerTooltip="More actions" items={items} />
    </>
  )
}

// A run's own directory: the folder holding `run.yaml` and everything beside it.
// Null when the state path is not a `run.yaml` — deleting the state FILE and
// leaving the rest of the folder behind is worse than refusing, so the caller
// disables the action rather than trimming nothing and deleting the wrong thing.
function sprintRunDirectory(statePath: string): string | null {
  const directory = statePath.replace(/[\\/]+run\.ya?ml$/iu, '')
  return directory && directory !== statePath ? directory : null
}

// Token usage as a readout, not a page: the run's total with its honest coverage
// note. A report that could not be read says so — never a zero (the counts are
// only truthful for agents whose CLI exposes them).
function TokenUsageAction({ model }: { model: SprintRunCanvasModel }): JSX.Element {
  const [open, setOpen] = useState(false)
  const report = useSprintEngineTokenUsage(model.statePath, model.state?.updatedAt ?? null, open)
  const measured = report && tokenReportHasAgents(report)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Token usage"
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="w-[280px] p-3"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <GhostButton ref={ref} onClick={togglePopover} {...triggerProps}>
          Token usage
        </GhostButton>
      )}
    >
      {!report ? (
        <p className="text-meta leading-5 text-[color:var(--text-muted)]">Reading this sprint’s token usage…</p>
      ) : !measured ? (
        <p className="text-meta leading-5 text-[color:var(--text-muted)]">
          No token usage recorded for this sprint yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-micro text-[color:var(--text-subtle)]">Total tokens</span>
            <span className="tabular-nums text-body font-semibold text-[color:var(--text-strong)]">
              {formatTokenCount(report.run.total.total)}
            </span>
          </div>
          {report.run.perModel.map((row) => (
            <div key={row.model} className="flex items-baseline justify-between gap-3">
              <TruncatedText
                as="span"
                text={row.model}
                className="min-w-0 text-micro text-[color:var(--text-muted)]"
              />
              <span className="tabular-nums text-micro text-[color:var(--text-default)]">
                {formatTokenCount(row.total)}
              </span>
            </div>
          ))}
          {describeTokenCoverage(report.run.coverage) ? (
            <p className="text-micro leading-4 text-[color:var(--text-subtle)]">
              {describeTokenCoverage(report.run.coverage)}
            </p>
          ) : null}
        </div>
      )}
    </Popover>
  )
}
