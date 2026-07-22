import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { PrimaryButton } from '../../../ui/Buttons'
import { useReviewSession } from '../../../panels/review/useReviewSession'
import { ReviewCanvas } from '../../../panels/review/ReviewCanvas'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import { ReviewsRail } from './ReviewsRail'
import { ReviewChangeForm } from './ReviewChangeForm'
import { orderReviewRail, resolveReviewAutoSelect } from './reviewRailModel'
import { buildReviewsSurfaceBar } from './ReviewSurfaceBar'

// How often the open door re-scans the review index so the rail's states stay
// honest (a sibling window posting, a walkthrough finishing) without ever
// re-entering the loading state — reload() replaces the index in place.
const REVIEW_INDEX_REFRESH_MS = 15_000

// The Reviews door — the full-page shell over the T5 instance index (MC-1708 T6,
// mockup §4). The rail lists every walkthrough across every project; the canvas is
// the selected review's walkthrough (chromeless, its top-bar actions folded into
// the shell bar); "Review a change" ingests a new one. Registered by the review
// module and mounted by WorkspaceManager over the card region when the door opens.
// No `onClose`: this is a page, not a dialog.

type SelectedReview = { reviewId: string; workspaceRoot: string }

type IndexPhase =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; entries: ReviewIndexEntry[] }

export default function ReviewsGlobalSurface(): JSX.Element {
  // Distinct project roots — the reviews are enumerated by scanning each one's
  // `.multi-code/review/` directory (T5 index). De-duplicated so the same folder
  // open in two windows is scanned once.
  const roots = useReviewProjectRoots()
  const back = useSurfaceBackNav()

  // The door unmounts on close, so the last-opened review is remembered in
  // persisted settings rather than component state — reopening restores it.
  const lastSelectedReview = useWorkspaceStore((state) => state.appSettings.lastSelectedReview)
  const setLastSelectedReview = useWorkspaceStore((state) => state.setLastSelectedReview)

  const [index, setIndex] = useState<IndexPhase>({ phase: 'loading' })
  const [selected, setSelected] = useState<SelectedReview | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      const result = await window.api.reviewList(roots)
      setIndex(result.ok ? { phase: 'ready', entries: result.reviews } : { phase: 'error', message: result.error })
    } catch (error) {
      setIndex({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [roots])

  // A background re-scan that never re-enters loading OR error: a transient poll
  // failure keeps the last good list on screen rather than blanking the rail. Used
  // by the interval and post-completion refresh; the mount and the retry button use
  // `reload`, which surfaces a first-load failure honestly.
  const refreshIndex = useCallback(async () => {
    try {
      const result = await window.api.reviewList(roots)
      if (result.ok) setIndex({ phase: 'ready', entries: result.reviews })
    } catch {
      // Keep the current index; the next tick (or an explicit retry) will recover.
    }
  }, [roots])

  // Load on mount and whenever the set of project roots changes.
  useEffect(() => {
    void reload()
  }, [reload])

  const entries = index.phase === 'ready' ? index.entries : []
  const rows = useMemo(() => orderReviewRail(entries), [entries])
  const selectedEntry = selected ? entries.find((entry) => entry.reviewId === selected.reviewId) ?? null : null

  // First load with nothing chosen: reopen the remembered review when the index
  // still has it, else fall back to the first row (the rail is ordered
  // attention-first) and drop the dead preference. Never overrides an explicit
  // selection, so a just-created review stays selected across the reload that
  // brings it into the list.
  useEffect(() => {
    if (index.phase !== 'ready' || creating || selected) return
    const decision = resolveReviewAutoSelect(entries, rows, lastSelectedReview)
    if (decision.clearRemembered) setLastSelectedReview(null)
    if (decision.select) setSelected(decision.select)
  }, [index.phase, creating, selected, rows, entries, lastSelectedReview, setLastSelectedReview])

  const session = useReviewSession({
    reviewId: selected?.reviewId ?? null,
    workspaceRoot: selected?.workspaceRoot ?? null,
  })

  // Keep the rail fresh while the door is open: a slow poll, plus an immediate
  // re-scan the moment a post finishes (posting → idle without an error), so the
  // just-posted review flips to "posted" in the rail without waiting for the tick.
  useEffect(() => {
    const id = window.setInterval(() => void refreshIndex(), REVIEW_INDEX_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [refreshIndex])

  const prevPostPhase = useRef(session.postState.phase)
  useEffect(() => {
    const previous = prevPostPhase.current
    prevPostPhase.current = session.postState.phase
    if (previous === 'posting' && session.postState.phase === 'idle') void refreshIndex()
  }, [session.postState.phase, refreshIndex])

  const onSelect = useCallback((reviewId: string) => {
    setCreating(false)
    const row = rows.find((r) => r.reviewId === reviewId)
    if (row) {
      const next = { reviewId: row.reviewId, workspaceRoot: row.workspaceRoot }
      setSelected(next)
      setLastSelectedReview(next)
    }
  }, [rows, setLastSelectedReview])

  const onNewReview = useCallback(() => setCreating(true), [])

  const onCreated = useCallback(
    (review: SelectedReview) => {
      setCreating(false)
      setSelected(review)
      setLastSelectedReview(review)
      void reload()
    },
    [reload, setLastSelectedReview],
  )

  const onCancelCreate = useCallback(() => setCreating(false), [])

  const bar = buildBar({ creating, hasSelection: selected !== null, selectedEntry, session })
  // The rail is present whenever the index has resolved — including on error, so a
  // failed scan is never a dead end: the (empty) list still carries "Review a
  // change". Only the pristine first load owns the full canvas alone (T20).
  const rail =
    index.phase === 'loading' ? undefined : (
      <ReviewsRail
        rows={rows}
        selectedReviewId={selected?.reviewId ?? null}
        newSelected={creating}
        onSelect={onSelect}
        onNewReview={onNewReview}
      />
    )

  return (
    <GlobalSurfaceShell ariaLabel="Reviews" bar={bar} rail={rail} onBack={back.onBack} canGoBack={back.canGoBack}>
      {renderCanvas({ index, creating, hasSelection: selected !== null, session, roots, onRetry: reload, onCreated, onCancelCreate, onNewReview })}
    </GlobalSurfaceShell>
  )
}

function buildBar({
  creating,
  hasSelection,
  selectedEntry,
  session,
}: {
  creating: boolean
  hasSelection: boolean
  selectedEntry: ReviewIndexEntry | null
  session: ReturnType<typeof useReviewSession>
}): GlobalSurfaceBar {
  if (creating) return { title: 'Review a change' }
  // A selected review drives the bar off its session, even before a just-created
  // one is re-scanned into the index (selectedEntry may still be null then).
  if (hasSelection) return buildReviewsSurfaceBar(selectedEntry, session)
  return { title: 'Reviews' }
}

function renderCanvas({
  index,
  creating,
  hasSelection,
  session,
  roots,
  onRetry,
  onCreated,
  onCancelCreate,
  onNewReview,
}: {
  index: IndexPhase
  creating: boolean
  hasSelection: boolean
  session: ReturnType<typeof useReviewSession>
  roots: string[]
  onRetry: () => void
  onCreated: (review: SelectedReview) => void
  onCancelCreate: () => void
  onNewReview: () => void
}): JSX.Element {
  if (creating) {
    return <ReviewChangeForm projectRoots={roots} onCreated={onCreated} onCancel={onCancelCreate} />
  }
  // A selected review renders as soon as it is chosen — the session loads it by id,
  // so it does not wait for the index re-scan to list a just-created one.
  if (hasSelection) return <ReviewCanvas session={session} />
  if (index.phase === 'loading') {
    return <SurfaceCanvasState kind="loading" label="Loading reviews…" />
  }
  if (index.phase === 'error') {
    // The rail stays present beside this (see the rail gate), so the shared error
    // card — plain sentence + retry — never withholds a way forward.
    return (
      <SurfaceCanvasState
        kind="error"
        title="Couldn’t list your reviews."
        hint="This is usually temporary."
        detail={index.message}
        onRetry={onRetry}
      />
    )
  }
  return (
    <SurfaceCanvasState
      kind="empty"
      glyph="◎"
      title="No reviews yet"
      body="Reviews from every project collect here. Start one from a pull request, branch, or patch and the guide walks you through the change."
      action={<PrimaryButton onClick={onNewReview}>Review a change</PrimaryButton>}
    />
  )
}

// Distinct project roots from the workspace list — the folders whose review dirs
// the index scans. Shallow-compared so the memoized array is stable between
// renders that do not change the set of open projects.
function useReviewProjectRoots(): string[] {
  return useWorkspaceStore(
    useShallow((state) => {
      const roots = new Set<string>()
      for (const workspace of state.workspaces) {
        if (workspace.folderPath) roots.add(workspace.folderPath)
      }
      return [...roots]
    }),
  )
}
