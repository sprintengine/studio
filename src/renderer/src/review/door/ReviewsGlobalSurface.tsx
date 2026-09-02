import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { ReviewIndexEntry } from '../../../../shared/electron-api'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { PrimaryButton } from '../../components/ui/Buttons'
import type { FilterMenuGroup } from '../../components/ui'
import { useReviewSession } from '../canvas/useReviewSession'
import { ReviewCanvas } from '../canvas/ReviewCanvas'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../../components/workspace/globalSurface/GlobalSurfaceShell'
import { SurfaceCanvasState } from '../../components/workspace/globalSurface/surfaceSubstrate'
import { useSurfaceBackNav } from '../../components/workspace/globalSurface/surfaceBackNav'
import { ReviewsRail } from './ReviewsRail'
import { ReviewChangeForm } from './ReviewChangeForm'
import { orderReviewRail, resolveReviewAutoSelect } from './reviewRailModel'
import { ReviewCanvasTools, buildReviewsSurfaceBar } from './ReviewSurfaceBar'
import { AskGuideDrawer, ReviewGuideActions, useReviewGuideRuntime } from './ReviewGuideControls'
import { ensureReviewsHostWorkspace } from './reviewsHostWorkspace'
import { useGuideTerminal } from './useGuideTerminal'
import { useLastSelectedReview, writeLastSelectedReview } from './reviewAppState'

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

// Filter sentinels for the rail's project/status lenses. A space prefix keeps
// the project sentinel from colliding with a real absolute root.
const ALL_PROJECTS = ' all'
const ALL_STATUSES = 'all'

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
  const lastSelectedReview = useLastSelectedReview()
  const setLastSelectedReview = writeLastSelectedReview

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

  // The rail's lens (the Backlog toolbar idiom): search over title/project, a
  // project filter, and a status filter. Transient per-window view state — it
  // narrows the rail only, never the canvas selection or the auto-select.
  const [railSearch, setRailSearch] = useState('')
  const [railProject, setRailProject] = useState<string>(ALL_PROJECTS)
  const [railStatus, setRailStatus] = useState<string>(ALL_STATUSES)

  const visibleRows = useMemo(() => {
    const query = railSearch.trim().toLowerCase()
    const projectByRoot = new Map(entries.map((entry) => [entry.workspaceRoot, entry.projectName]))
    return rows.filter((row) => {
      if (railProject !== ALL_PROJECTS && row.workspaceRoot !== railProject) return false
      if (railStatus !== ALL_STATUSES && row.status !== railStatus) return false
      if (!query) return true
      return (
        row.title.toLowerCase().includes(query) ||
        (projectByRoot.get(row.workspaceRoot) ?? '').toLowerCase().includes(query)
      )
    })
  }, [rows, entries, railSearch, railProject, railStatus])

  // One filter group per axis. Projects are offered only when there is a second
  // one to choose between — a lone option beside "All projects" filters nothing.
  const railFilterGroups = useMemo(() => {
    const byRoot = new Map<string, { label: string; count: number }>()
    for (const entry of entries) {
      const existing = byRoot.get(entry.workspaceRoot)
      if (existing) existing.count += 1
      else byRoot.set(entry.workspaceRoot, { label: entry.projectName, count: 1 })
    }
    const groups: FilterMenuGroup[] = []
    if (byRoot.size > 1) {
      groups.push({
        label: 'Project',
        items: [
          { value: ALL_PROJECTS, label: `All projects · ${entries.length}` },
          ...[...byRoot.entries()]
            .map(([root, info]) => ({ value: root, label: `${info.label} · ${info.count}` }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ],
        value: railProject,
        defaultValue: ALL_PROJECTS,
        onChange: setRailProject,
      })
    }
    groups.push({
      label: 'Status',
      items: [
        { value: ALL_STATUSES, label: 'All' },
        { value: 'in-progress', label: 'In progress' },
        { value: 'draft', label: 'Draft' },
        { value: 'posted', label: 'Posted' },
      ],
      value: railStatus,
      defaultValue: ALL_STATUSES,
      onChange: setRailStatus,
    })
    return groups
  }, [entries, railProject, railStatus])

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

  // The preparation choices (how deep, which agent) and where the guide's terminal
  // is. Both are door-level concerns — the canvas stays a pure projection of the
  // session — so they are resolved here and handed down as a slot. Depth rides the
  // session explicitly: every start and freshness re-run carries the reviewer's
  // persisted pick, and there is no default further down to fall back on.
  const guideRuntime = useReviewGuideRuntime()
  // Resolved when a guide is actually asked for, not on render: the first call
  // for a project CREATES its Reviews host (MC-1911).
  const selectedRoot = selected?.workspaceRoot ?? null
  const resolveHostWorkspaceId = useCallback(
    () => ensureReviewsHostWorkspace(selectedRoot),
    [selectedRoot],
  )
  const session = useReviewSession({
    reviewId: selected?.reviewId ?? null,
    workspaceRoot: selectedRoot,
    depth: guideRuntime.depth,
    guideCli: guideRuntime.cli,
    resolveHostWorkspaceId,
    ...(guideRuntime.model ? { guideModel: guideRuntime.model } : {}),
  })
  const guideTerminal = useGuideTerminal({
    reviewId: selected?.reviewId ?? null,
    guide: session.guide,
  })
  const guideActions = <ReviewGuideActions session={session} runtime={guideRuntime} terminal={guideTerminal} />

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

  const bar = buildBar({
    creating,
    hasSelection: selected !== null,
    selectedEntry,
    session,
    // Whichever the review is asking for right now: the preparation choices while
    // there is no walkthrough, the walkthrough's own tools once there is one.
    guideControls: session.isDegraded || session.run.running ? guideActions : <ReviewCanvasTools session={session} />,
  })
  // The rail is DECLARED, not derived from what the door happens to hold (T19):
  // present in every load state, so opening the door replaces the projects rail
  // immediately. It used to withhold the rail on the pristine first load, which
  // left that one state with the projects sidebar beside the door's own canvas —
  // two navigation columns, which item 1993 forbids outright. The (empty) list
  // still carries "Review a change", so a failed or still-loading scan is never a
  // dead end either.
  const rail = (
    <ReviewsRail
      rows={visibleRows}
      selectedReviewId={selected?.reviewId ?? null}
      newSelected={creating}
      search={{
        value: railSearch,
        onChange: setRailSearch,
        placeholder: 'Search reviews…',
        ariaLabel: 'Search reviews across every project',
      }}
      filter={{ ariaLabel: 'Filter reviews', groups: railFilterGroups }}
      onSelect={onSelect}
      onNewReview={onNewReview}
      // The lens is narrower than the reviews behind it. Say so, rather than
      // letting an empty rail read as "you have no reviews".
      emptyNotice={rows.length > 0 ? 'No reviews match.' : undefined}
    />
  )

  return (
    <>
      <GlobalSurfaceShell ariaLabel="Reviews" bar={bar} rail={rail} onBack={back.onBack} canGoBack={back.canGoBack}>
        {renderCanvas({ index, creating, hasSelection: selected !== null, session, guideActions, roots, onRetry: reload, onCreated, onCancelCreate, onNewReview })}
      </GlobalSurfaceShell>
      {/* The ask composer is a fixed-position drawer over the whole door, so it
          sits outside the shell rather than inside the canvas region. */}
      {selected ? <AskGuideDrawer session={session} terminal={guideTerminal} /> : null}
    </>
  )
}

function buildBar({
  creating,
  hasSelection,
  selectedEntry,
  session,
  guideControls,
}: {
  creating: boolean
  hasSelection: boolean
  selectedEntry: ReviewIndexEntry | null
  session: ReturnType<typeof useReviewSession>
  guideControls: ReactNode
}): GlobalSurfaceBar {
  if (creating) return { title: 'Review a change' }
  // A selected review drives the bar off its session, even before a just-created
  // one is re-scanned into the index (selectedEntry may still be null then).
  if (hasSelection) return buildReviewsSurfaceBar(selectedEntry, session, guideControls)
  return { title: 'Reviews' }
}

function renderCanvas({
  index,
  creating,
  hasSelection,
  session,
  guideActions,
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
  guideActions: ReactNode
  roots: string[]
  onRetry: () => void
  onCreated: (review: SelectedReview) => void
  onCancelCreate: () => void
  onNewReview: () => void
}): JSX.Element {
  if (creating) {
    return <ReviewChangeForm projectRoots={roots} onCreated={onCreated} onCancel={onCancelCreate} />
  }
  // A selected review renders as soon as it is chosen — the session loads it by
  // id, so it does not wait for the index re-scan to list a just-created one.
  // Both the guide's controls and the walkthrough's tools ride the door bar in
  // the app strip; the canvas is the change and nothing else.
  if (hasSelection) {
    return <ReviewCanvas session={session} guideActions={guideActions} />
  }
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
  // First run: the door has never held a review, so this canvas keeps the
  // richer treatment; the glyph is an svg, never a text character.
  return (
    <SurfaceCanvasState
      kind="empty"
      firstRun
      glyph={<ReviewsDoorGlyph />}
      title="No reviews yet"
      body="Reviews from every project collect here. Start one from a pull request, branch, or patch and the guide walks you through the change."
      action={<PrimaryButton onClick={onNewReview}>Review a change</PrimaryButton>}
    />
  )
}

// The door's mark for its first-run canvas: a ring with a centre — the eye a
// walkthrough puts on a change. An svg on the icon ramp, sized for the
// substrate's accent disc.
function ReviewsDoorGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="icon-lg" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
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
