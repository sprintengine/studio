import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { ReviewIndexEntry } from '../../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { Spinner } from '../../../ui/Spinner'
import { PrimaryButton } from '../../../ui/Buttons'
import { InlineNotice } from '../../../ui/InlineNotice'
import { useReviewSession } from '../../../panels/review/useReviewSession'
import { ReviewCanvas } from '../../../panels/review/ReviewCanvas'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { ReviewsRail } from './ReviewsRail'
import { ReviewChangeForm } from './ReviewChangeForm'
import { orderReviewRail } from './reviewRailModel'
import { buildReviewsSurfaceBar } from './ReviewSurfaceBar'

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

  // Load on mount and whenever the set of project roots changes.
  useEffect(() => {
    void reload()
  }, [reload])

  const entries = index.phase === 'ready' ? index.entries : []
  const rows = useMemo(() => orderReviewRail(entries), [entries])
  const selectedEntry = selected ? entries.find((entry) => entry.reviewId === selected.reviewId) ?? null : null

  // First load with reviews and nothing chosen: open the first one (the rail is
  // ordered attention-first). Never overrides an explicit selection, so a just-
  // created review stays selected across the reload that brings it into the list.
  useEffect(() => {
    if (index.phase !== 'ready' || creating || selected || rows.length === 0) return
    const first = rows[0]
    setSelected({ reviewId: first.reviewId, workspaceRoot: first.workspaceRoot })
  }, [index.phase, creating, selected, rows])

  const session = useReviewSession({
    reviewId: selected?.reviewId ?? null,
    workspaceRoot: selected?.workspaceRoot ?? null,
  })

  const onSelect = useCallback((reviewId: string) => {
    setCreating(false)
    const row = rows.find((r) => r.reviewId === reviewId)
    if (row) setSelected({ reviewId: row.reviewId, workspaceRoot: row.workspaceRoot })
  }, [rows])

  const onNewReview = useCallback(() => setCreating(true), [])

  const onCreated = useCallback(
    (review: SelectedReview) => {
      setCreating(false)
      setSelected(review)
      void reload()
    },
    [reload],
  )

  const onCancelCreate = useCallback(() => setCreating(false), [])

  const bar = buildBar({ creating, hasSelection: selected !== null, selectedEntry, session })
  const rail =
    index.phase === 'ready' ? (
      <ReviewsRail
        rows={rows}
        selectedReviewId={selected?.reviewId ?? null}
        newSelected={creating}
        onSelect={onSelect}
        onNewReview={onNewReview}
      />
    ) : undefined

  return (
    <GlobalSurfaceShell ariaLabel="Reviews" bar={bar} rail={rail}>
      {renderCanvas({ index, creating, hasSelection: selected !== null, session, roots, onCreated, onCancelCreate, onNewReview })}
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
  onCreated,
  onCancelCreate,
  onNewReview,
}: {
  index: IndexPhase
  creating: boolean
  hasSelection: boolean
  session: ReturnType<typeof useReviewSession>
  roots: string[]
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
    return (
      <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] text-[13px] text-[color:var(--text-muted)]">
        <Spinner /> <span className="ml-2">Loading reviews…</span>
      </div>
    )
  }
  if (index.phase === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-6">
        <InlineNotice tone="error" className="max-w-md">
          <span className="font-medium">Couldn’t list your reviews.</span>
          <span className="mt-1 block text-[12px]">{index.message}</span>
        </InlineNotice>
      </div>
    )
  }
  return <ReviewsEmptyState onNewReview={onNewReview} />
}

function ReviewsEmptyState({ onNewReview }: { onNewReview: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[color:var(--bg-surface)] px-6">
      <div className="max-w-md text-center">
        <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">No reviews yet</h3>
        <p className="mt-1.5 text-[12.5px] leading-5 text-[color:var(--text-muted)]">
          Reviews from every project collect here. Start one from a pull request, branch, or patch and the guide walks
          you through the change.
        </p>
        <div className="mt-4 flex justify-center">
          <PrimaryButton onClick={onNewReview}>Review a change</PrimaryButton>
        </div>
      </div>
    </div>
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
