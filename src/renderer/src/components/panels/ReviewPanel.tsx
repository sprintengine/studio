import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import type {
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewBrief,
  ReviewChangeSet,
  ReviewWorkspaceState,
} from '../../../../shared/review'
import type { ReviewBriefRunPhase } from '../../../../shared/electron-api'
import { InlineNotice } from '../ui/InlineNotice'
import { PrimaryButton } from '../ui/Buttons'
import { Spinner } from '../ui/Spinner'
import { ReviewWalkthrough } from './review/ReviewWalkthrough'
import type { ReviewPostPhase } from './review/ReviewTray'
import {
  addComment,
  applyPostFailure,
  applyPostOutcomes,
  canPostReview,
  deleteComment,
  editComment,
  isPullRequestReviewSource,
  markCommentsPosting,
  newReviewComment,
} from './review/commentModel'
import { FreshnessBanner } from './review/FreshnessBanner'
import { resolveActivePaneId, sourceIdentity } from './review/reviewSelectors'
import {
  buildCurrentBanner,
  buildStaleBanner,
  computeFreshness,
  migrateReviewState,
  reconstructSourceInput,
} from './review/freshness'
import { useReviewFreshness } from './review/useReviewFreshness'

// The review workspace surface (MC-1680). It loads the validated triple — the
// change set (MC-1676), the guide's brief (MC-1679), and the reviewer's own
// workspace state — and projects the guided walkthrough. It renders no judgments
// and takes no action on the reviewed code. Every load failure is shown
// explicitly; an absent brief invites the guide to run rather than blanking.

type ChangesetLoad =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; changeset: ReviewChangeSet | null }

type BriefLoad =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'absent' }
  | { phase: 'invalid'; errors: string }
  | { phase: 'ready'; brief: ReviewBrief }

interface RunProgress {
  running: boolean
  phase: ReviewBriefRunPhase | null
  detail?: string
  error: string | null
}

const RUN_PHASE_LABEL: Record<ReviewBriefRunPhase, string> = {
  reading: 'Reading the change…',
  grouping: 'Grouping the change into steps…',
  annotating: 'Checking the walkthrough…',
  writing: 'Saving the walkthrough…',
  done: 'Walkthrough ready',
  failed: 'The guide could not finish',
}

function defaultReviewState(changeSetId: string): ReviewWorkspaceState {
  return { schemaVersion: 1, changeSetId, readFiles: [], diffView: 'side-by-side', comments: [] }
}

export default function ReviewPanel({ workspaceId }: { workspaceId: string }) {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const guideConfig = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.reviewGuideConfig ?? null,
  )
  // Reviewer state (read progress, view mode, comments) lives on disk beside the
  // change set (`<reviewDir>/state.json`, MC-1708), keyed by review id — no longer
  // on the retired `review` workspace's store field. It is loaded once per review
  // and every mutation is persisted back through review IPC.
  const [storedState, setStoredState] = useState<ReviewWorkspaceState | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)
  const monacoTheme = useMonacoBaseTheme()

  const [changesetLoad, setChangesetLoad] = useState<ChangesetLoad>({ phase: 'loading' })
  const [briefLoad, setBriefLoad] = useState<BriefLoad>({ phase: 'idle' })
  const [run, setRun] = useState<RunProgress>({ running: false, phase: null, error: null })
  // The quiet "current with <sha>" settle line shown after a successful refresh
  // (mockup §4). Null hides it; it persists until the next stale detection.
  const [settle, setSettle] = useState<{ headSha?: string; refreshedStepIds: string[] } | null>(null)
  // The post-to-PR batch (MC-1683): idle, in-flight, or a whole-batch failure. The
  // per-comment posted/held state lives on the comments themselves; this only
  // drives the tray button label and the batch-error line.
  const [postState, setPostState] = useState<ReviewPostPhase>({ phase: 'idle' })
  // Set while a re-run is migrating reviewer state across the new change set id, so
  // the default-state reset effect below does not clobber the migration mid-swap.
  const refreshInFlightRef = useRef(false)

  const target = useMemo(() => (folderPath ? { workspaceRoot: folderPath, workspaceId } : null), [folderPath, workspaceId])

  // Persist the reviewer's state to disk and mirror it locally. Every mutation
  // (read toggle, view choice, comment CRUD, re-run migration) routes through here
  // — the disk write is the source of truth that survives restart and a guide
  // re-run, and the local mirror drives the immediate render.
  const persistReviewState = useCallback(
    (next: ReviewWorkspaceState) => {
      setStoredState(next)
      if (target) void window.api.reviewWriteState(target, next)
    },
    [target],
  )

  // Load the reviewer's persisted state for this review. Keyed by target so it
  // reloads if the review identity changes; `stateLoaded` gates the default-state
  // write below so it never clobbers a state still in flight from disk.
  useEffect(() => {
    if (!target) {
      setStoredState(null)
      setStateLoaded(true)
      return
    }
    let cancelled = false
    setStateLoaded(false)
    void (async () => {
      try {
        const result = await window.api.reviewReadState(target)
        if (cancelled) return
        setStoredState(result.ok ? result.state : null)
      } catch {
        if (!cancelled) setStoredState(null)
      } finally {
        if (!cancelled) setStateLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target])

  const loadChangeset = useCallback(async () => {
    if (!target) {
      setChangesetLoad({ phase: 'error', message: 'This review workspace has no project folder.' })
      return null
    }
    setChangesetLoad({ phase: 'loading' })
    try {
      const result = await window.api.reviewReadChangeset(target)
      if (result.ok) {
        setChangesetLoad({ phase: 'ready', changeset: result.changeset })
        return result.changeset
      }
      setChangesetLoad({ phase: 'error', message: result.error })
    } catch (error) {
      setChangesetLoad({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    return null
  }, [target])

  const loadBrief = useCallback(async () => {
    if (!target) return
    setBriefLoad({ phase: 'loading' })
    try {
      const result = await window.api.reviewReadBrief(target)
      if (!result.ok) setBriefLoad({ phase: 'invalid', errors: result.error })
      else if (result.brief === null) setBriefLoad({ phase: 'absent' })
      else setBriefLoad({ phase: 'ready', brief: result.brief })
    } catch (error) {
      setBriefLoad({ phase: 'invalid', errors: error instanceof Error ? error.message : String(error) })
    }
  }, [target])

  // Initial load: change set, then brief (only when a change set exists).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const changeset = await loadChangeset()
      if (cancelled || !changeset) return
      await loadBrief()
    })()
    return () => {
      cancelled = true
    }
  }, [loadChangeset, loadBrief])

  // Live guide-run progress. Filtered to this workspace; on completion re-reads
  // the brief so a fresh walkthrough replaces the prepare/failed state.
  useEffect(() => {
    const off = window.api.onReviewBriefRunEvent((event) => {
      if (event.workspaceId !== workspaceId) return
      if (event.phase === 'done') {
        setRun({ running: false, phase: 'done', error: null })
        void loadBrief()
      } else if (event.phase === 'failed') {
        setRun({ running: false, phase: 'failed', error: event.detail ?? 'The guide could not finish.' })
      } else {
        setRun({ running: true, phase: event.phase, detail: event.detail, error: null })
      }
    })
    return off
  }, [workspaceId, loadBrief])

  const startRun = useCallback(async () => {
    if (!target) return
    setRun({ running: true, phase: 'reading', error: null })
    try {
      const result = await window.api.reviewStartBriefRun({
        workspaceId,
        workspaceRoot: target.workspaceRoot,
        depth: guideConfig?.depth ?? 'standard',
      })
      if (!result.ok) {
        setRun({ running: false, phase: 'failed', error: result.errors.join('\n') })
        if (result.reason === 'validation') setBriefLoad({ phase: 'invalid', errors: result.errors.join('\n') })
      } else {
        // The 'done' event normally finalizes and re-reads the brief; reload here
        // too so a dropped event can never leave the panel stuck on "Preparing…".
        setRun({ running: false, phase: 'done', error: null })
        await loadBrief()
      }
    } catch (error) {
      setRun({ running: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }, [target, workspaceId, guideConfig])

  const changeset = changesetLoad.phase === 'ready' ? changesetLoad.changeset : null
  const brief = briefLoad.phase === 'ready' ? briefLoad.brief : null

  // The reviewer state, resolved against the current change set. A persisted
  // state for a different change set (a re-ingest) resets to defaults.
  const resolvedState = useMemo<ReviewWorkspaceState | null>(() => {
    if (!changeset) return null
    if (storedState && storedState.changeSetId === changeset.id) return storedState
    return defaultReviewState(changeset.id)
  }, [changeset, storedState])

  // Persist the default once so reading progress and view choice survive restart.
  // Gated on the disk state having loaded, so it never races the initial read and
  // clobbers persisted progress. A re-run migrates state across the new change set
  // id itself (see `refresh`), so this reset is suppressed mid-refresh — otherwise
  // it would wipe the migration.
  useEffect(() => {
    if (refreshInFlightRef.current) return
    if (!stateLoaded) return
    if (changeset && (!storedState || storedState.changeSetId !== changeset.id)) {
      persistReviewState(defaultReviewState(changeset.id))
    }
  }, [changeset, storedState, stateLoaded, persistReviewState])

  const patchState = useCallback(
    (patch: Partial<ReviewWorkspaceState>) => {
      if (!resolvedState) return
      persistReviewState({ ...resolvedState, ...patch })
    },
    [resolvedState, persistReviewState],
  )

  const readFiles = useMemo(() => new Set(resolvedState?.readFiles ?? []), [resolvedState])
  const diffView: DiffView = resolvedState?.diffView ?? 'side-by-side'
  const activePaneId = useMemo(
    () => (brief ? resolveActivePaneId(brief, resolvedState) : 'overview'),
    [brief, resolvedState],
  )

  const onToggleRead = useCallback(
    (path: string) => {
      if (!resolvedState) return
      const next = resolvedState.readFiles.includes(path)
        ? resolvedState.readFiles.filter((p) => p !== path)
        : [...resolvedState.readFiles, path]
      patchState({ readFiles: next })
    },
    [resolvedState, patchState],
  )

  const noop = useCallback(() => {}, [])
  const onAskGuide = useCallback((_annotation: ReviewAnnotation) => {}, [])

  // Comment CRUD — the only path by which a comment enters state. The guide never
  // reaches this; comments come from the composer's create action alone. Each
  // mutation round-trips through ReviewWorkspaceState (persisted on the workspace
  // snapshot), so an add/edit/delete survives restart and a guide re-run.
  const onCreateComment = useCallback(
    (path: string, anchor: ReviewAnchor, body: string) => {
      if (!resolvedState) return
      const comment = newReviewComment({
        id: crypto.randomUUID(),
        path,
        anchor,
        body,
        createdAt: new Date().toISOString(),
        headSha: changeset?.headSha,
      })
      patchState({ comments: addComment(resolvedState.comments, comment) })
    },
    [resolvedState, patchState, changeset],
  )

  const onEditComment = useCallback(
    (id: string, body: string) => {
      if (!resolvedState) return
      patchState({ comments: editComment(resolvedState.comments, id, body) })
    },
    [resolvedState, patchState],
  )

  const onDeleteComment = useCallback(
    (id: string) => {
      if (!resolvedState) return
      patchState({ comments: deleteComment(resolvedState.comments, id) })
    },
    [resolvedState, patchState],
  )

  // Post the pending review to the pull request (MC-1683) — a human-outward,
  // batched action gated to this window's gesture (the main-process IPC refuses
  // any non-window caller, so the guide can never reach it). The optimistic flip
  // and the outcome/failure apply both derive from the same pre-post snapshot, so
  // they never compound. GitHub's create-review is atomic: a batch failure posts
  // nothing and every postable comment flips to a retryable "failed".
  const onPostReview = useCallback(async () => {
    if (!target || !resolvedState || !changeset) return
    const original = resolvedState.comments
    if (!canPostReview(changeset, original)) return
    setPostState({ phase: 'posting' })
    patchState({ comments: markCommentsPosting(original) })
    try {
      const result = await window.api.reviewPostReview({ target, comments: original })
      if (!result.ok) {
        patchState({ comments: applyPostFailure(original, result.error) })
        setPostState({ phase: 'error', error: result.error })
        return
      }
      patchState({ comments: applyPostOutcomes(original, result.outcomes) })
      setPostState({ phase: 'idle' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      patchState({ comments: applyPostFailure(original, message) })
      setPostState({ phase: 'error', error: message })
    }
  }, [target, resolvedState, changeset, patchState])

  // Freshness: probe whether the reviewed head moved past this walkthrough. Branch
  // sources key off the git-status snapshot; PR sources probe on reveal (debounced);
  // patch sources never go stale. The hook never mutates anything.
  const freshness = useReviewFreshness(folderPath, changeset, brief)

  // Re-run (top bar + banner): re-ingest the source, migrate reviewer state across
  // the new change set (read progress on unchanged files stays, changed files flip
  // to unread, comments survive with a 'moved' flag when their file changed), and
  // regenerate only the affected steps. The old walkthrough stays rendered until
  // the new brief lands; a failed/interrupted run leaves the old brief + banner
  // untouched.
  const refresh = useCallback(async () => {
    if (!target || !changeset) return
    const sourceInput = reconstructSourceInput(changeset)
    // A patch has no upstream to re-ingest, so Re-run just regenerates the
    // walkthrough against the same change set (a full guide run).
    if (!sourceInput) {
      await startRun()
      return
    }
    const oldChangeset = changeset
    const oldState =
      storedState && storedState.changeSetId === oldChangeset.id ? storedState : defaultReviewState(oldChangeset.id)
    setRun({ running: true, phase: 'reading', error: null })
    setSettle(null)
    try {
      const ingested = await window.api.reviewIngestSource(sourceInput, target)
      if (!ingested.ok) {
        setRun({ running: false, phase: 'failed', error: ingested.error })
        return
      }
      const newChangeset = ingested.changeset
      const affectedStepIds = brief ? computeFreshness(oldChangeset, newChangeset, brief).affectedStepIds : []
      const runResult = await window.api.reviewStartBriefRun({
        workspaceId,
        workspaceRoot: target.workspaceRoot,
        depth: guideConfig?.depth ?? 'standard',
        affectedStepIds,
      })
      if (!runResult.ok) {
        // The run wrote no brief and did not touch the on-disk brief, so the old
        // walkthrough is still valid; surface the failure and keep it rendered.
        setRun({ running: false, phase: 'failed', error: runResult.errors.join('\n') })
        return
      }
      // Success: migrate state, swap the change set in place, and load the new brief.
      // The reset effect is suppressed across this window so the migration survives.
      refreshInFlightRef.current = true
      persistReviewState(migrateReviewState(oldState, oldChangeset, newChangeset))
      setChangesetLoad({ phase: 'ready', changeset: newChangeset })
      await loadBrief()
      setRun({ running: false, phase: 'done', error: null })
      setSettle({ headSha: newChangeset.headSha, refreshedStepIds: affectedStepIds })
    } catch (error) {
      setRun({ running: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      refreshInFlightRef.current = false
    }
  }, [target, changeset, storedState, brief, workspaceId, guideConfig, persistReviewState, loadBrief, startRun])

  if (changesetLoad.phase === 'loading') {
    return <CenteredState><Spinner /> <span className="ml-2">Loading the change…</span></CenteredState>
  }
  if (changesetLoad.phase === 'error') {
    return (
      <CenteredState>
        <div className="max-w-md">
          <h3 className="mb-1.5 text-[15px] font-semibold text-[color:var(--text-strong)]">Couldn’t open this review</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">{changesetLoad.message}</p>
        </div>
      </CenteredState>
    )
  }
  if (!changeset) {
    return (
      <CenteredState>
        <div className="max-w-md">
          <h3 className="mb-1.5 text-[15px] font-semibold text-[color:var(--text-strong)]">No change to review yet</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
            This review workspace has no change loaded. Create a review from a pull request, branch, or patch.
          </p>
        </div>
      </CenteredState>
    )
  }

  // Change set present. If the brief is invalid, show the failure with Retry.
  if (briefLoad.phase === 'invalid') {
    return (
      <PrepareShell changeset={changeset}>
        <InlineNotice tone="error" className="max-w-2xl">
          <span className="font-medium">The walkthrough didn’t pass its checks.</span>
          <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-5">
            {briefLoad.errors}
          </pre>
        </InlineNotice>
        <div className="mt-3">
          <PrimaryButton onClick={startRun} disabled={run.running}>
            {run.running ? 'Preparing…' : 'Try again'}
          </PrimaryButton>
        </div>
        <RunLine run={run} />
      </PrepareShell>
    )
  }

  // No brief yet — invite the guide to prepare the walkthrough.
  if (briefLoad.phase !== 'ready') {
    const preparing = run.running || briefLoad.phase === 'loading'
    return (
      <PrepareShell changeset={changeset}>
        <p className="max-w-xl text-[13px] leading-6 text-[color:var(--text-muted)]">
          The guide hasn’t walked this change yet. Prepare the walkthrough to group the files into steps ordered for
          understanding, with a short note on why each one changed.
        </p>
        <div className="mt-3">
          <PrimaryButton onClick={startRun} disabled={preparing}>
            {preparing ? 'Preparing…' : 'Prepare walkthrough'}
          </PrimaryButton>
        </div>
        <RunLine run={run} />
      </PrepareShell>
    )
  }

  const bannerModel = freshness
    ? buildStaleBanner(changeset.source, briefLoad.brief, freshness.result)
    : settle
      ? buildCurrentBanner(settle.headSha, briefLoad.brief, settle.refreshedStepIds)
      : null

  const bannerSlot = bannerModel ? (
    <FreshnessBanner
      model={bannerModel}
      refreshing={run.running}
      refreshPhase={run.phase}
      onRefresh={refresh}
    />
  ) : null

  return (
    <ReviewWalkthrough
      changeset={changeset}
      brief={briefLoad.brief}
      readFiles={readFiles}
      diffView={diffView}
      activePaneId={activePaneId}
      monacoTheme={monacoTheme}
      rerunning={run.running}
      onSetActivePane={(id) => patchState({ activeStepId: id })}
      onSetDiffView={(view) => patchState({ diffView: view })}
      onToggleRead={onToggleRead}
      onRequestComment={noop}
      onAskGuide={onAskGuide}
      onRerun={refresh}
      bannerSlot={bannerSlot}
      comments={resolvedState?.comments ?? []}
      onCreateComment={onCreateComment}
      onEditComment={onEditComment}
      onDeleteComment={onDeleteComment}
      onPostReview={isPullRequestReviewSource(changeset) ? onPostReview : undefined}
      postState={postState}
      workspaceId={workspaceId}
      workspaceRoot={folderPath ?? undefined}
    />
  )
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-6 text-[13px] text-[color:var(--text-muted)]">
      {children}
    </div>
  )
}

// The prepare/failure shell keeps the source identity visible so the reviewer
// always knows what they are about to walk, even before a brief exists.
function PrepareShell({ changeset, children }: { changeset: ReviewChangeSet; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-6 py-6">
      <header className="mb-5">
        <h2 className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
          {changeset.title}
        </h2>
        <p className="mt-1 font-mono text-[12px] text-[color:var(--text-subtle)]">
          {sourceIdentity(changeset)} · <span className="tabular-nums">{changeset.stats.files}</span>{' '}
          {changeset.stats.files === 1 ? 'file' : 'files'} ·{' '}
          <span className="tabular-nums text-[color:var(--tone-good)]">+{changeset.stats.additions}</span>{' '}
          <span className="tabular-nums text-[color:var(--tone-error)]">−{changeset.stats.deletions}</span>
        </p>
      </header>
      {children}
    </div>
  )
}

function RunLine({ run }: { run: RunProgress }) {
  if (run.error) {
    return (
      <p className="mt-3 max-w-2xl text-[12px] leading-5 text-[color:var(--tone-error)]">{run.error}</p>
    )
  }
  if (!run.running || !run.phase) return null
  return (
    <p className="mt-3 flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
      <Spinner />
      {RUN_PHASE_LABEL[run.phase]}
    </p>
  )
}
