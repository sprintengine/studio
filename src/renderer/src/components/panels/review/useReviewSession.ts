import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useMonacoBaseTheme } from '../../../hooks/useAppTheme'
import type {
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewBrief,
  ReviewChangeSet,
  ReviewComment,
  ReviewWorkspaceState,
} from '../../../../../shared/review'
import type { ReviewBriefRunDepth, ReviewBriefRunPhase } from '../../../../../shared/electron-api'
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
} from './commentModel'
import {
  buildCurrentBanner,
  buildStaleBanner,
  computeFreshness,
  migrateReviewState,
  reconstructSourceInput,
} from './freshness'
import { resolveActivePaneId } from './reviewSelectors'
import { useReviewFreshness } from './useReviewFreshness'
import type { FreshnessBannerModel } from './freshness'
import type { ReviewChatController, ReviewDrawerController } from './ReviewWalkthrough'
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
  | 'prepare' // no walkthrough yet — invite the guide
  | 'ready' // walkthrough present

export interface ReviewRunProgress {
  running: boolean
  phase: ReviewBriefRunPhase | null
  detail?: string
  error: string | null
}

export interface ReviewSession {
  reviewId: string | null
  workspaceRoot: string | null
  status: ReviewSessionStatus
  changeset: ReviewChangeSet | null
  brief: ReviewBrief | null
  errorMessage: string | null
  invalidErrors: string | null
  run: ReviewRunProgress
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
  // Drawer chrome, driven from the folded surface bar.
  trayController: ReviewDrawerController
  chatController: ReviewChatController
  openTray: () => void
  openChat: () => void
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
  depth?: ReviewBriefRunDepth
}

export function useReviewSession({ reviewId, workspaceRoot, depth = 'standard' }: UseReviewSessionParams): ReviewSession {
  const monacoTheme = useMonacoBaseTheme()

  const [storedState, setStoredState] = useState<ReviewWorkspaceState | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [changesetLoad, setChangesetLoad] = useState<ChangesetLoad>({ phase: 'loading' })
  const [briefLoad, setBriefLoad] = useState<BriefLoad>({ phase: 'idle' })
  const [run, setRun] = useState<ReviewRunProgress>({ running: false, phase: null, error: null })
  const [settle, setSettle] = useState<{ headSha?: string; refreshedStepIds: string[] } | null>(null)
  const [postState, setPostState] = useState<ReviewPostPhase>({ phase: 'idle' })
  const refreshInFlightRef = useRef(false)

  // Drawer state for the folded surface bar (the walkthrough itself is chromeless
  // on the door). Prefill + its re-apply nonce live here so both the bar's clean
  // "Ask the guide" and a note-card "Ask the guide" drive one composer.
  const [trayOpen, setTrayOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined)
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
    setRun({ running: false, phase: null, error: null })
    setSettle(null)
    setPostState({ phase: 'idle' })
    setTrayOpen(false)
    setChatOpen(false)
    setChatPrefill(undefined)
  }, [target])

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

  // Live guide-run progress, filtered to this review.
  useEffect(() => {
    if (!reviewId) return
    const off = window.api.onReviewBriefRunEvent((event) => {
      if (event.workspaceId !== reviewId) return
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
  }, [reviewId, loadBrief])

  const startRun = useCallback(async () => {
    if (!target) return
    setRun({ running: true, phase: 'reading', error: null })
    try {
      const result = await window.api.reviewStartBriefRun({
        workspaceId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        depth,
      })
      if (!result.ok) {
        setRun({ running: false, phase: 'failed', error: result.errors.join('\n') })
        if (result.reason === 'validation') setBriefLoad({ phase: 'invalid', errors: result.errors.join('\n') })
      } else {
        setRun({ running: false, phase: 'done', error: null })
        await loadBrief()
      }
    } catch (error) {
      setRun({ running: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }, [target, depth, loadBrief])

  const changeset = changesetLoad.phase === 'ready' ? changesetLoad.changeset : null
  const brief = briefLoad.phase === 'ready' ? briefLoad.brief : null

  const resolvedState = useMemo<ReviewWorkspaceState | null>(() => {
    if (!changeset) return null
    if (storedState && storedState.changeSetId === changeset.id) return storedState
    return defaultReviewState(changeset.id)
  }, [changeset, storedState])

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

  const freshness = useReviewFreshness(workspaceRoot, changeset, brief)

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
        workspaceId: target.workspaceId,
        workspaceRoot: target.workspaceRoot,
        depth,
        affectedStepIds,
      })
      if (!runResult.ok) {
        setRun({ running: false, phase: 'failed', error: runResult.errors.join('\n') })
        return
      }
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
  }, [target, changeset, storedState, brief, depth, persistReviewState, loadBrief, startRun])

  const comments = resolvedState?.comments ?? []
  const bannerModel = useMemo<FreshnessBannerModel | null>(() => {
    if (!brief || !changeset) return null
    if (freshness) return buildStaleBanner(changeset.source, brief, freshness.result)
    if (settle) return buildCurrentBanner(settle.headSha, brief, settle.refreshedStepIds)
    return null
  }, [brief, changeset, freshness, settle])

  // Chat controller for the chromeless walkthrough: a note-card "Ask the guide"
  // pre-quotes that annotation; the surface bar's "Ask the guide" opens a clean one.
  const chatController = useMemo<ReviewChatController>(
    () => ({
      open: chatOpen,
      setOpen: setChatOpen,
      prefill: chatPrefill,
      askFromCard: (annotation: ReviewAnnotation) => {
        prefillNonce.current += 1
        setChatPrefill({ text: `> ${annotation.path} ${anchorRangeLabel(annotation.anchor)}\n\n`, nonce: prefillNonce.current })
        setChatOpen(true)
      },
    }),
    [chatOpen, chatPrefill],
  )
  const trayController = useMemo<ReviewDrawerController>(() => ({ open: trayOpen, setOpen: setTrayOpen }), [trayOpen])
  const openTray = useCallback(() => setTrayOpen(true), [])
  const openChat = useCallback(() => {
    setChatPrefill(undefined)
    setChatOpen(true)
  }, [])

  const status = resolveStatus(target !== null, changesetLoad, briefLoad, changeset)

  return {
    reviewId,
    workspaceRoot,
    status,
    changeset,
    brief,
    errorMessage: changesetLoad.phase === 'error' ? changesetLoad.message : null,
    invalidErrors: briefLoad.phase === 'invalid' ? briefLoad.errors : null,
    run,
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
    trayController,
    chatController,
    openTray,
    openChat,
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
  return 'prepare'
}
