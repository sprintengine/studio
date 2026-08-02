import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import type {
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
  ReviewWorkspaceState,
} from '../../../../shared/review'
import type {
  ReviewAskGuideResult,
  ReviewBriefRunDepth,
  ReviewBriefRunPhase,
  ReviewGuideRunStatus,
  ReviewGuideTerminal,
} from '../../../../shared/electron-api'
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
  pendingCommentCount,
  postableComments,
} from './commentModel'
import {
  buildCurrentBanner,
  buildStaleBanner,
  computeFreshness,
  migrateReviewState,
  reconstructSourceInput,
} from './freshness'
import { synthesizeDegradedBrief } from './degradedBrief'
import { resolveActivePaneId } from './reviewSelectors'
import { useReviewFreshness } from './useReviewFreshness'
import type { FreshnessBannerModel } from './freshness'
import type { ReviewDrawerController } from './ReviewWalkthrough'
import type { ReviewPostPhase } from './ReviewTray'
import { anchorRangeLabel } from './anchorLabel'

// The review session hook (MC-1708 T6). It carries everything the retired
// `ReviewPanel` owned — the validated change-set + brief + reviewer-state triple,
// the guide run, freshness, comments, and the post-to-PR batch — but keyed by a
// review id + project root instead of a workspace store row (the `review`
// workspace type is gone). The Reviews door surface calls it once for the selected
// review and feeds the result to both the folded surface bar and the chromeless
// canvas, so the two never drift. Passing a null review id yields the idle session
// (no review selected) without violating the rules of hooks.

export type ReviewSessionStatus =
  | 'idle' // no review selected
  | 'loading' // reading the change set
  | 'error' // the change set could not be read
  | 'no-change' // the review has no change set ingested
  | 'invalid-brief' // the walkthrough failed its checks
  | 'degraded' // changeset present, no guide brief — raw change, synthesized walkthrough
  | 'ready' // guide walkthrough present

export interface ReviewRunProgress {
  running: boolean
  phase: ReviewBriefRunPhase | null
  detail?: string
  error: string | null
}

// "Ask the guide" (MC-1783): the composer drawer the door opens. The guide is an
// ordinary terminal agent now, so there is no thread to project here — the
// question is delivered to its terminal and the answer is read there.
// `askFromCard` opens the composer pre-quoted at an annotation's anchor.
export interface ReviewAskController extends ReviewDrawerController {
  prefill?: { text: string; nonce: number }
  askFromCard: (annotation: ReviewAnnotation) => void
}

export interface ReviewSession {
  reviewId: string | null
  workspaceRoot: string | null
  status: ReviewSessionStatus
  // True in the 'degraded' state: `brief` is the renderer-synthesized model, not a
  // guide's. Lets the surface hide guide-only chrome without duplicating the check.
  isDegraded: boolean
  changeset: ReviewChangeSet | null
  // The guide's brief when 'ready'; the synthesized degraded model when 'degraded';
  // null otherwise. The synthesized one is never written to disk.
  brief: ReviewBrief | null
  errorMessage: string | null
  invalidErrors: string | null
  run: ReviewRunProgress
  // Where this review's guide terminal lives, once a start or an ask has reported
  // it. Null before either — a remount reads the run's *phase* back from the main
  // process but not its coordinates, so the door finds the terminal among the live
  // sessions instead (see reviewGuideTerminal.ts).
  guide: ReviewGuideTerminal | null
  // Walkthrough props (present when status === 'ready').
  readFiles: ReadonlySet<string>
  diffView: DiffView
  activePaneId: string
  monacoTheme: 'vs' | 'vs-dark'
  comments: ReviewComment[]
  bannerModel: FreshnessBannerModel | null
  postState: ReviewPostPhase
  // Derived bar inputs.
  isPullRequest: boolean
  pendingComments: number
  canPost: boolean
  // Actions.
  onSetActivePane: (id: string) => void
  onSetDiffView: (view: DiffView) => void
  onToggleRead: (path: string) => void
  onCreateComment: (path: string, anchor: ReviewAnchor, body: string) => void
  onEditComment: (id: string, body: string) => void
  onDeleteComment: (id: string) => void
  onPostReview: () => void
  startRun: () => void
  refresh: () => void
  // Deliver one question to the guide's terminal. The answer is not in the result
  // — the reviewer reads it there; this reports only whether it was delivered.
  askGuide: (message: string) => Promise<ReviewAskGuideResult>
  // Drawer chrome, driven from the folded surface bar.
  trayController: ReviewDrawerController
  askController: ReviewAskController
  openTray: () => void
  openAsk: () => void
}

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

function defaultReviewState(changeSetId: string): ReviewWorkspaceState {
  return { schemaVersion: 1, changeSetId, readFiles: [], diffView: 'side-by-side', comments: [] }
}

export interface UseReviewSessionParams {
  reviewId: string | null
  workspaceRoot: string | null
  // How deep a walkthrough to ask for. Required, and with no default here on
  // purpose (MC-1788): the reviewer picks it on the prepare banner and it is
  // persisted, so a default parameter would silently outrank their choice the
  // moment a caller forgot to thread it.
  depth: ReviewBriefRunDepth
  // Which agent CLI (and model) runs the guide. The guide is an ordinary terminal
  // agent, so this is the reviewer's pick from the door's runtime picker. Omitted,
  // the main process falls back to a live guide's CLI, then the project's last
  // agent CLI, and finally fails visibly rather than guessing an engine.
  guideCli?: string
  guideModel?: string
  // The workspace that hosts the guide's terminal (MC-1911), resolved at the
  // moment a guide is asked for — never during render, because resolving it
  // CREATES the project's Reviews host on first use. A door-level concern like
  // depth and CLI: this hook stays free of the workspace store, and a caller
  // that supplies none leaves the main process to pick.
  resolveHostWorkspaceId?: () => string | null
}

// The idle run state, and the projection of the main process's record of a run
// onto it. A terminal phase is retained with `running: false`, which is what lets
// a remount say "the last run failed, here is why" instead of showing a bare
// prepare button (MC-1784).
const IDLE_RUN: ReviewRunProgress = { running: false, phase: null, error: null }

function runFromStatus(status: ReviewGuideRunStatus): ReviewRunProgress {
  if (status.running) return { running: true, phase: status.phase, detail: status.detail, error: null }
  if (status.phase === 'failed') {
    return { running: false, phase: 'failed', error: status.detail ?? 'The guide could not finish.' }
  }
  return { running: false, phase: status.phase, detail: status.detail, error: null }
}

export function useReviewSession({
  reviewId,
  workspaceRoot,
  depth,
  guideCli,
  guideModel,
  resolveHostWorkspaceId,
}: UseReviewSessionParams): ReviewSession {
  const monacoTheme = useMonacoBaseTheme()
  // Called at start/ask time, never on render. Held in a ref so the callbacks
  // below do not re-create themselves (and re-arm their effects) whenever the
  // door hands down a fresh closure.
  const hostWorkspaceRef = useRef(resolveHostWorkspaceId)
  hostWorkspaceRef.current = resolveHostWorkspaceId
  const hostWorkspace = useCallback((): { hostWorkspaceId?: string } => {
    const hostWorkspaceId = hostWorkspaceRef.current?.()
    return hostWorkspaceId ? { hostWorkspaceId } : {}
  }, [])

  const [storedState, setStoredState] = useState<ReviewWorkspaceState | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [changesetLoad, setChangesetLoad] = useState<ChangesetLoad>({ phase: 'loading' })
  const [briefLoad, setBriefLoad] = useState<BriefLoad>({ phase: 'idle' })
  const [run, setRun] = useState<ReviewRunProgress>(IDLE_RUN)
  const [guide, setGuide] = useState<ReviewGuideTerminal | null>(null)
  const [settle, setSettle] = useState<{ headSha?: string; refreshedStepIds: string[] } | null>(null)
  const [postState, setPostState] = useState<ReviewPostPhase>({ phase: 'idle' })
  const refreshInFlightRef = useRef(false)

  // Live mirror of the run so the one-writer guard reads the CURRENT phase rather
  // than a value captured when a callback was created: pressing Prepare against a
  // run already in flight must join it, never start a second guide.
  const runRef = useRef<ReviewRunProgress>(run)
  const applyRun = useCallback((next: ReviewRunProgress) => {
    runRef.current = next
    setRun(next)
  }, [])
  // A freshness re-run's "current again" banner, held until the guide actually
  // finishes. The run now resolves when the terminal has the prompt, not when the
  // walkthrough exists, so settling on the IPC result would claim it was rebuilt
  // while the guide is still working.
  const pendingSettleRef = useRef<{ headSha?: string; refreshedStepIds: string[] } | null>(null)

  // Drawer state for the folded surface bar (the walkthrough itself is chromeless
  // on the door). Prefill + its re-apply nonce live here so both the bar's clean
  // "Ask the guide" and a note-card "Ask the guide" drive one composer.
  const [trayOpen, setTrayOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [askPrefill, setAskPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined)
  const prefillNonce = useRef(0)

  // The review identity for IPC. `workspaceId` is the review id — the on-disk
  // directory key the change-set service uses — carried over from when a review
  // was a workspace. Null until a review is selected.
  const target = useMemo(
    () => (reviewId && workspaceRoot ? { workspaceRoot, workspaceId: reviewId } : null),
    [reviewId, workspaceRoot],
  )

  const persistReviewState = useCallback(
    (next: ReviewWorkspaceState) => {
      setStoredState(next)
      if (target) void window.api.reviewWriteState(target, next)
    },
    [target],
  )

  // Reset per-review transient state whenever the selected review changes, so a
  // newly selected review never renders the previous one's brief/run/drawers.
  useEffect(() => {
    setChangesetLoad(target ? { phase: 'loading' } : { phase: 'ready', changeset: null })
    setBriefLoad({ phase: 'idle' })
    applyRun(IDLE_RUN)
    setGuide(null)
    pendingSettleRef.current = null
    setSettle(null)
    setPostState({ phase: 'idle' })
    setTrayOpen(false)
    setAskOpen(false)
    setAskPrefill(undefined)
  }, [target, applyRun])

  // Seed the run from the main process's own record (MC-1784). The guide outlives
  // this component: navigating away mid-run and back must show "the guide is
  // working", not an idle prepare button. A local start already in flight wins —
  // it is newer than whatever this read was told.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    void (async () => {
      try {
        const status = await window.api.reviewBriefRunStatus(target)
        if (cancelled || !status || runRef.current.running) return
        applyRun(runFromStatus(status))
      } catch {
        // No record to seed from; the resting state is the honest fallback.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, applyRun])

  // Load the reviewer's persisted state for this review.
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
    if (!target) return null
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
    if (!target) return
    let cancelled = false
    void (async () => {
      const changeset = await loadChangeset()
      if (cancelled || !changeset) return
      await loadBrief()
    })()
    return () => {
      cancelled = true
    }
  }, [target, loadChangeset, loadBrief])

  // Live guide-run progress, filtered to this review. This — not the start call —
  // is what ends a run: the guide works in its own terminal and the brief lands
  // asynchronously through the review MCP tools.
  useEffect(() => {
    if (!reviewId) return
    const off = window.api.onReviewBriefRunEvent((event) => {
      if (event.workspaceId !== reviewId) return
      if (event.phase === 'done') {
        applyRun({ running: false, phase: 'done', error: null })
        void loadBrief()
        // A freshness re-run's settle waits for exactly this moment.
        const pending = pendingSettleRef.current
        if (pending) {
          pendingSettleRef.current = null
          setSettle(pending)
        }
      } else if (event.phase === 'failed') {
        pendingSettleRef.current = null
        applyRun({ running: false, phase: 'failed', error: event.detail ?? 'The guide could not finish.' })
      } else {
        applyRun({ running: true, phase: event.phase, detail: event.detail, error: null })
      }
    })
    return off
  }, [reviewId, loadBrief, applyRun])

  // Start the guide (MC-1783). `ok` means its terminal has the prompt, NOT that a
  // walkthrough exists — the run stays open until the `done` event lands the
  // brief. Pressing Prepare against a live run joins it instead of starting a
  // second guide; the engine enforces the same rule, this is the local floor.
  const startRun = useCallback(async () => {
    if (!target || runRef.current.running) return
    applyRun({ running: true, phase: 'reading', error: null })
    try {
      const result = await window.api.reviewStartBriefRun({
        workspaceId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        ...hostWorkspace(),
        depth,
        ...(guideCli ? { cli: guideCli } : {}),
        ...(guideModel ? { cliModel: guideModel } : {}),
      })
      if (!result.ok) {
        applyRun({ running: false, phase: 'failed', error: result.errors.join('\n') })
        if (result.reason === 'validation') setBriefLoad({ phase: 'invalid', errors: result.errors.join('\n') })
        return
      }
      if (result.guide) setGuide(result.guide)
      // A join reports the run already in flight; adopt its phase rather than
      // restarting the local progress line from `reading`.
      if (result.joined) applyRun(runFromStatus(result.status))
    } catch (error) {
      applyRun({ running: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }, [target, depth, guideCli, guideModel, hostWorkspace, applyRun])

  const changeset = changesetLoad.phase === 'ready' ? changesetLoad.changeset : null
  // The guide's brief, present only when it validated on disk. Freshness/staleness
  // apply to this one alone — a synthesized fallback can never be "stale".
  const realBrief = briefLoad.phase === 'ready' ? briefLoad.brief : null
  const status = resolveStatus(target !== null, changesetLoad, briefLoad, changeset)
  // In the degraded state expose a synthesized model so the walkthrough renders the
  // raw change (diff, read-toggles, comments) with no guide. It is memoized off the
  // changeset and never persisted; `brief.json` on disk always means a guide ran.
  const brief = useMemo<ReviewBrief | null>(() => {
    if (realBrief) return realBrief
    if (status === 'degraded' && changeset) return synthesizeDegradedBrief(changeset)
    return null
  }, [realBrief, status, changeset])

  const resolvedState = useMemo<ReviewWorkspaceState | null>(() => {
    if (!changeset) return null
    if (storedState && storedState.changeSetId === changeset.id) return storedState
    return defaultReviewState(changeset.id)
  }, [changeset, storedState])

  // Live mirror of the resolved state so a functional patchState reads the LATEST
  // value at write time, not one captured when an async post began.
  const latestStateRef = useRef(resolvedState)
  latestStateRef.current = resolvedState

  useEffect(() => {
    if (refreshInFlightRef.current) return
    if (!stateLoaded) return
    if (changeset && (!storedState || storedState.changeSetId !== changeset.id)) {
      persistReviewState(defaultReviewState(changeset.id))
    }
  }, [changeset, storedState, stateLoaded, persistReviewState])

  const patchState = useCallback(
    (patch: Partial<ReviewWorkspaceState> | ((prev: ReviewWorkspaceState) => Partial<ReviewWorkspaceState>)) => {
      const base = latestStateRef.current
      if (!base) return
      persistReviewState({ ...base, ...(typeof patch === 'function' ? patch(base) : patch) })
    },
    [persistReviewState],
  )

  const readFiles = useMemo(() => new Set(resolvedState?.readFiles ?? []), [resolvedState])
  const diffView: DiffView = resolvedState?.diffView ?? 'side-by-side'
  const activePaneId = useMemo(() => (brief ? resolveActivePaneId(brief, resolvedState) : 'overview'), [brief, resolvedState])

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

  const onPostReview = useCallback(async () => {
    if (!target || !resolvedState || !changeset || !canPostReview(changeset, resolvedState.comments)) return
    // The batch is exactly the comments postable at send time; its ids scope the
    // failure apply so a comment composed mid-post is never marked failed.
    const batch = postableComments(resolvedState.comments)
    const batchIds = batch.map((comment) => comment.id)
    setPostState({ phase: 'posting' })
    patchState({ comments: markCommentsPosting(resolvedState.comments) })
    try {
      const result = await window.api.reviewPostReview({ target, comments: batch })
      if (result.ok) {
        patchState((prev) => ({ comments: applyPostOutcomes(prev.comments, result.outcomes) }))
        setPostState({ phase: 'idle' })
      } else {
        patchState((prev) => ({ comments: applyPostFailure(prev.comments, batchIds, result.error) }))
        setPostState({ phase: 'error', error: result.error })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      patchState((prev) => ({ comments: applyPostFailure(prev.comments, batchIds, message) }))
      setPostState({ phase: 'error', error: message })
    }
  }, [target, resolvedState, changeset, patchState])

  const freshness = useReviewFreshness(workspaceRoot, changeset, realBrief)

  // Re-run against a moved head. Unlike Prepare this one REPLACES a run in flight
  // (`restart: true`) — rebuilding against the new head is the whole point — but it
  // still waits for the guide's `done` event before claiming the walkthrough is
  // current again, which is what `pendingSettleRef` holds.
  const refresh = useCallback(async () => {
    if (!target || !changeset) return
    const sourceInput = reconstructSourceInput(changeset)
    if (!sourceInput) {
      await startRun()
      return
    }
    const oldChangeset = changeset
    const oldState =
      storedState && storedState.changeSetId === oldChangeset.id ? storedState : defaultReviewState(oldChangeset.id)
    applyRun({ running: true, phase: 'reading', error: null })
    pendingSettleRef.current = null
    setSettle(null)
    try {
      const ingested = await window.api.reviewIngestSource(sourceInput, target)
      if (!ingested.ok) {
        applyRun({ running: false, phase: 'failed', error: ingested.error })
        return
      }
      const newChangeset = ingested.changeset
      const affectedStepIds = realBrief ? computeFreshness(oldChangeset, newChangeset, realBrief).affectedStepIds : []
      const runResult = await window.api.reviewStartBriefRun({
        workspaceId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        ...hostWorkspace(),
        depth,
        affectedStepIds,
        restart: true,
        ...(guideCli ? { cli: guideCli } : {}),
        ...(guideModel ? { cliModel: guideModel } : {}),
      })
      if (!runResult.ok) {
        applyRun({ running: false, phase: 'failed', error: runResult.errors.join('\n') })
        return
      }
      if (runResult.guide) setGuide(runResult.guide)
      refreshInFlightRef.current = true
      persistReviewState(migrateReviewState(oldState, oldChangeset, newChangeset))
      setChangesetLoad({ phase: 'ready', changeset: newChangeset })
      // The previous walkthrough stays on screen (against the new change set, so
      // the stale banner keeps explaining itself) until the guide replaces it.
      await loadBrief()
      pendingSettleRef.current = { headSha: newChangeset.headSha, refreshedStepIds: affectedStepIds }
    } catch (error) {
      applyRun({ running: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      refreshInFlightRef.current = false
    }
  }, [
    target,
    changeset,
    storedState,
    realBrief,
    depth,
    guideCli,
    guideModel,
    hostWorkspace,
    persistReviewState,
    loadBrief,
    startRun,
    applyRun,
  ])

  // Deliver one question to the guide's terminal, starting it if none is live.
  // Nothing here reads an answer: it arrives in the terminal, which is the point
  // of the redesign — the review surface stops mirroring a chat it cannot own.
  const askGuide = useCallback(
    async (message: string): Promise<ReviewAskGuideResult> => {
      if (!target) return { ok: false, error: 'No review is selected.' }
      try {
        const result = await window.api.reviewAskGuide({
          workspaceId: target.workspaceId,
          workspaceRoot: target.workspaceRoot,
          ...hostWorkspace(),
          message,
          ...(guideCli ? { cli: guideCli } : {}),
          ...(guideModel ? { cliModel: guideModel } : {}),
        })
        if (result.ok && result.guide) setGuide(result.guide)
        return result
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    [target, guideCli, guideModel, hostWorkspace],
  )

  const comments = resolvedState?.comments ?? []
  const bannerModel = useMemo<FreshnessBannerModel | null>(() => {
    // Freshness banners describe the guide's walkthrough against a moved head; the
    // synthesized degraded model has no such history, so it never shows one.
    if (!realBrief || !changeset) return null
    if (freshness) return buildStaleBanner(changeset.source, realBrief, freshness.result)
    if (settle) return buildCurrentBanner(settle.headSha, realBrief, settle.refreshedStepIds)
    return null
  }, [realBrief, changeset, freshness, settle])

  // Ask controller for the chromeless walkthrough: a note-card "Ask the guide"
  // pre-quotes that annotation; the surface bar's "Ask the guide" opens a clean one.
  const askController = useMemo<ReviewAskController>(
    () => ({
      open: askOpen,
      setOpen: setAskOpen,
      prefill: askPrefill,
      askFromCard: (annotation: ReviewAnnotation) => {
        prefillNonce.current += 1
        setAskPrefill({ text: `> ${annotation.path} ${anchorRangeLabel(annotation.anchor)}\n\n`, nonce: prefillNonce.current })
        setAskOpen(true)
      },
    }),
    [askOpen, askPrefill],
  )
  const trayController = useMemo<ReviewDrawerController>(() => ({ open: trayOpen, setOpen: setTrayOpen }), [trayOpen])
  const openTray = useCallback(() => setTrayOpen(true), [])
  const openAsk = useCallback(() => {
    setAskPrefill(undefined)
    setAskOpen(true)
  }, [])

  return {
    reviewId,
    workspaceRoot,
    status,
    isDegraded: status === 'degraded',
    changeset,
    brief,
    errorMessage: changesetLoad.phase === 'error' ? changesetLoad.message : null,
    invalidErrors: briefLoad.phase === 'invalid' ? briefLoad.errors : null,
    run,
    guide,
    readFiles,
    diffView,
    activePaneId,
    monacoTheme,
    comments,
    bannerModel,
    postState,
    isPullRequest: changeset ? isPullRequestReviewSource(changeset) : false,
    pendingComments: pendingCommentCount(comments),
    canPost: changeset ? canPostReview(changeset, comments) : false,
    onSetActivePane: (id: string) => patchState({ activeStepId: id }),
    onSetDiffView: (view) => patchState({ diffView: view }),
    onToggleRead,
    onCreateComment,
    onEditComment,
    onDeleteComment,
    onPostReview,
    startRun,
    refresh,
    askGuide,
    trayController,
    askController,
    openTray,
    openAsk,
  }
}

function resolveStatus(
  hasTarget: boolean,
  changesetLoad: ChangesetLoad,
  briefLoad: BriefLoad,
  changeset: ReviewChangeSet | null,
): ReviewSessionStatus {
  if (!hasTarget) return 'idle'
  if (changesetLoad.phase === 'loading') return 'loading'
  if (changesetLoad.phase === 'error') return 'error'
  if (!changeset) return 'no-change'
  if (briefLoad.phase === 'invalid') return 'invalid-brief'
  if (briefLoad.phase === 'ready') return 'ready'
  // The brief's disk state is still unknown (not yet read) — hold on 'loading'
  // rather than flashing the raw change before a real walkthrough resolves.
  if (briefLoad.phase === 'idle' || briefLoad.phase === 'loading') return 'loading'
  // briefLoad.phase === 'absent': a changeset with no guide brief → degraded.
  return 'degraded'
}
