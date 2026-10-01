import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as Monaco from 'monaco-editor'

import type { LiveTourStep, TourAsk } from '../../../../../shared/tours/tour-types'
import { tourStepLocation } from '../../../../../shared/tours/tour-ask'
import { useGitTreeRevision } from '../../../hooks/useGitStatus'
import { renderMarkdown } from '../../../utils/markdown'
import { isWindowVisible } from '../../../utils/windowActivity'
import {
  ChipButton,
  TourCallout,
  TourReadyCard,
  TourStepList,
  TourStrip,
  type TourCalloutAskState,
  type TourProgressMark,
  type TourStepListItem,
} from '../../ui'
import type { DiffFileItem } from '../diffFileList'
import {
  forcedLayout,
  gotoDecision,
  isTourItem,
  readingTimeMs,
  stepFileIndexes,
  tourItems,
  tourKeyAction,
  visit,
  type TourDiffItem,
  type TourPlayState,
} from './tourModel'
import { useDiffTour } from './useDiffTour'
import { useTourSession } from './useTourSession'

// Tour mode for the Diff viewer, in two halves because the viewer needs one
// answer before it knows what file is on screen and the rest after:
//
//   useTourState  — which tour is open, whether it is playing, and the item
//                   list the viewer steps through while it is (read before the
//                   viewer builds its own list).
//   useTourPlayer — everything that needs the file on screen: driving the
//                   cursor to a step's file, the Monaco layer, the strip, the
//                   step list, the Start card, Play, Follow and asking.
//
// Nothing here takes focus, and nothing plays until Start.

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export type TourState = ReturnType<typeof useTourState>

/** What the host remembers for the viewer across a remount (the pane tab). */
export type TourHostState = {
  /** The tour this viewer had open, and whether it was playing. */
  current: { id: string; playing: boolean } | null
  /** A tour an agent has just written, not yet seen by the owner. */
  offer: string | null
}

export function useTourState({
  workspaceId,
  host,
  visible,
}: {
  workspaceId: string | null
  host: TourHostState | null
  /** Whether the viewer is on screen right now. */
  visible: boolean
}) {
  const [openTourId, setOpenTourId] = useState<string | null>(host?.current?.id ?? host?.offer ?? null)
  // A tour that was PLAYING when this viewer was last mounted picks up where
  // it was — the owner started it; switching tabs is not leaving it.
  const resumeRef = useRef<string | null>(host?.current?.playing ? host.current.id : null)
  const openRef = useRef(openTourId)
  openRef.current = openTourId
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // An agent's new tour. Opened straight away only when nothing would be
  // covered by its Start card: the viewer is off screen and holds no tour.
  // Otherwise it waits as a chip — a tour the owner is reading, or a diff they
  // are looking at, is never replaced by an agent finishing a tour.
  const offer = host?.offer ?? null
  const [pendingOffer, setPendingOffer] = useState<string | null>(null)
  useEffect(() => {
    if (!offer) {
      setPendingOffer(null)
      return
    }
    if (offer === openRef.current) return
    if (openRef.current === null && !visibleRef.current) {
      setOpenTourId(offer)
      setPendingOffer(null)
      return
    }
    setPendingOffer(offer)
  }, [offer])

  // A working-tree tour's steps are re-found against the files on disk, so the
  // tour's own repository's tree ticks are what re-read it.
  const [tourRepo, setTourRepo] = useState<string | null>(null)
  const tourTree = useGitTreeRevision(tourRepo)
  const session = useTourSession(workspaceId, openTourId, tourTree)
  const tour = session.tour
  const liveRepo = tour && tour.revisions.head === 'worktree' ? tour.repoRoot : null
  useEffect(() => {
    setTourRepo(liveRepo)
  }, [liveRepo])

  const [started, setStarted] = useState(false)
  const [play, setPlay] = useState<TourPlayState>({ index: null, visited: [] })
  const [follow, setFollow] = useState(false)
  // A different tour opened: start from its card again, and read what that
  // tour remembers (even when it is the same tour opened a second time).
  const hydratedRef = useRef<string | null>(null)
  useEffect(() => {
    setStarted(false)
    setPlay({ index: null, visited: [] })
    hydratedRef.current = null
  }, [openTourId])
  // What this tour remembers from an earlier viewing: visited steps and Follow.
  useEffect(() => {
    if (!tour || hydratedRef.current === tour.id) return
    hydratedRef.current = tour.id
    setPlay({ index: null, visited: tour.playback.visited })
    setFollow(tour.playback.follow)
  }, [tour])

  const active = Boolean(tour && started && tour.steps.length > 0)
  const items = useMemo<TourDiffItem[] | null>(() => (tour && active ? tourItems(tour) : null), [tour, active])

  return {
    workspaceId,
    offer,
    pendingOffer,
    takePendingOffer: () => {
      if (!pendingOffer) return
      setOpenTourId(pendingOffer)
      setPendingOffer(null)
    },
    resumeRef,
    tourTree,
    openTourId,
    setOpenTourId,
    tour,
    error: session.error,
    started,
    setStarted,
    play,
    setPlay,
    follow,
    setFollow,
    active,
    items,
  }
}

type DiffState = { version: number; key: string | null }

export type TourPlayerInput = {
  state: TourState
  currentItem: DiffFileItem | null
  currentIndex: number
  /** Put the viewer's cursor on item `index` of the tour's list. */
  selectItem: (index: number) => void
  contentState: 'loading' | 'error' | 'binary' | 'too-large' | 'ready'
  /** The last diff Monaco drew, and for which item (`kind:path`). */
  diffState: DiffState
  editor: Monaco.editor.IStandaloneDiffEditor | null
  monaco: typeof Monaco | null
  host: HTMLElement | null
  /** Whether this viewer is on screen: the pane's Diff tab is the one showing. */
  visible: boolean
  hideUnchanged: boolean
  /** The owner has seen the agent's offered tour (started it, or put it off). */
  onOfferTaken?: () => void
  /** What the viewer has open now, for the host to keep across a remount. */
  onCurrentChange?: (current: TourHostState['current']) => void
}

export function useTourPlayer({
  state,
  currentItem,
  currentIndex,
  selectItem,
  contentState,
  diffState,
  editor,
  monaco,
  host,
  visible,
  hideUnchanged,
  onOfferTaken,
  onCurrentChange,
}: TourPlayerInput) {
  const { tour, active, items, play, setPlay, follow, setFollow, started, setStarted, workspaceId, openTourId } = state
  const reducedMotion = prefersReducedMotion()
  const [playing, setPlaying] = useState(false)
  const [hold, setHold] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [pointerSeenAt, setPointerSeenAt] = useState(0)
  const [localAsk, setLocalAsk] = useState<Record<string, TourCalloutAskState>>({})
  const onTourSeen = useCallback(() => {
    if (openTourId && openTourId === state.offer) onOfferTaken?.()
  }, [openTourId, state.offer, onOfferTaken])

  const steps = useMemo(() => tour?.steps ?? [], [tour])
  const index = active ? play.index : null
  const step: LiveTourStep | null = index !== null ? (steps[index] ?? null) : null
  const stepFiles = useMemo(() => (tour && items ? stepFileIndexes(tour, items) : []), [tour, items])
  const stepFileIndex = index !== null ? (stepFiles[index] ?? -1) : -1

  const goTo = useCallback(
    (next: number) => {
      if (!tour) return
      setPlay((current) => visit(current, tour.steps, next))
    },
    [tour, setPlay],
  )
  const goNext = useCallback(() => {
    if (index !== null && index < steps.length - 1) goTo(index + 1)
  }, [index, steps.length, goTo])
  const goPrev = useCallback(() => {
    if (index !== null && index > 0) goTo(index - 1)
  }, [index, goTo])

  // ── Driving the cursor to the step's file ─────────────────────────────
  // A step in another file fades the editor, swaps its models (the same
  // mounted editor, the same move a file step makes), and fades back in once
  // the new diff is drawn. Arriving from outside the tour (Start) just lands.
  useEffect(() => {
    if (!active || stepFileIndex < 0 || currentIndex === stepFileIndex) return
    const fromTour = isTourItem(currentItem)
    if (!fromTour || reducedMotion) {
      selectItem(stepFileIndex)
      return
    }
    setSwapping(true)
    const timer = window.setTimeout(() => selectItem(stepFileIndex), 120)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepFileIndex, currentIndex])

  const onStepFile =
    Boolean(step && currentItem && isTourItem(currentItem)) && currentItem!.relativePath === step!.anchor.path
  const itemKey = currentItem ? `${currentItem.kind}:${currentItem.path}` : null
  const layerStep = onStepFile && contentState === 'ready' && diffState.key === itemKey ? step : null

  useEffect(() => {
    if (layerStep || (onStepFile && contentState !== 'ready' && contentState !== 'loading')) setSwapping(false)
  }, [layerStep, onStepFile, contentState])
  useEffect(() => {
    if (!active) setSwapping(false)
  }, [active])

  const fileSteps = useMemo(
    () => (layerStep ? steps.filter((entry) => entry.anchor.path === layerStep.anchor.path) : []),
    [steps, layerStep],
  )
  const layer = useDiffTour({
    editor,
    monaco,
    step: layerStep,
    fileSteps,
    diffVersion: diffState.version,
    host,
    reducedMotion,
  })

  // ── Options the step needs from the editor ─────────────────────────────
  const layout = active ? forcedLayout(step) : null
  const collapsedHere = useMemo(() => {
    if (!hideUnchanged || !layerStep || layerStep.startLine === null || !editor) return false
    const changes = editor.getLineChanges() ?? []
    const side = layerStep.fileStatus === 'deleted' || layerStep.anchor.side === 'new' ? 'modified' : 'original'
    const context = 3
    return !changes.some((change) => {
      const start = side === 'modified' ? change.modifiedStartLineNumber : change.originalStartLineNumber
      const end = side === 'modified' ? change.modifiedEndLineNumber : change.originalEndLineNumber
      const last = Math.max(start, end)
      return layerStep.startLine! <= last + context && layerStep.endLine! >= start - context
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideUnchanged, layerStep?.id, layerStep?.startLine, layerStep?.endLine, diffState.version, editor])

  const optionOverrides = useMemo<Monaco.editor.IDiffEditorOptions>(
    () => ({
      smoothScrolling: active && !reducedMotion,
      ...(layout
        ? { renderSideBySide: layout === 'side-by-side', useInlineViewWhenSpaceIsLimited: layout !== 'side-by-side' }
        : { useInlineViewWhenSpaceIsLimited: true }),
      ...(collapsedHere ? { hideUnchangedRegions: { enabled: false } } : {}),
    }),
    [active, reducedMotion, layout, collapsedHere],
  )

  // ── Play ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) setPlaying(false)
  }, [active])
  // A new step lets go of any hold the last one's callout had: that callout
  // may have unmounted under the pointer without a mouse-leave.
  const stepId = step?.id ?? null
  useEffect(() => {
    setHold(false)
  }, [stepId])
  // Keyed on the step's id and its words, not the step object: a re-read of
  // the tour (a report, a tree tick) must not restart the reading time.
  const dwellMs = step ? readingTimeMs(step) : 0
  useEffect(() => {
    if (!playing || hold || stepId === null || index === null) return
    const timer = window.setTimeout(() => (index >= steps.length - 1 ? setPlaying(false) : goTo(index + 1)), dwellMs)
    return () => window.clearTimeout(timer)
  }, [playing, hold, stepId, dwellMs, index, steps.length, goTo])

  // ── Reporting back ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!workspaceId || !openTourId || !tour) return
    // Only a viewer that is PLAYING reports: one showing the Start card knows
    // nothing the tour does not, and reporting "no current step" from it would
    // erase where the owner left off.
    if (!started || !step) return
    void window.api.tourReportPlayback(workspaceId, openTourId, {
      started,
      currentStepId: step?.id ?? null,
      visited: play.visited,
      follow,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, openTourId, started, step?.id, play.visited, follow])

  // ── The agent pointing ─────────────────────────────────────────────────
  const pointer = tour?.pointer ?? null
  const pointerIndex = pointer ? steps.findIndex((entry) => entry.id === pointer.stepId) : -1
  useEffect(() => {
    if (pointer && pointerIndex === index) setPointerSeenAt(pointer.at)
  }, [pointer, pointerIndex, index])

  const gotoRef = useRef<(stepId: string) => { moved: boolean; reason: string }>(() => ({
    moved: false,
    reason: 'not_showing',
  }))
  gotoRef.current = (stepId) => {
    // On screen means the tab is the one showing AND the window is not hidden,
    // minimised or covered — main's window signal, which the page's own
    // visibility does not report on macOS.
    const showing = visible && isWindowVisible()
    const decision = gotoDecision({ showing, started: active, follow })
    const target = steps.findIndex((entry) => entry.id === stepId)
    if (decision.moved && target >= 0) goTo(target)
    return decision
  }
  useEffect(() => {
    if (!openTourId) return
    return window.api.onTourGotoRequest((request) => {
      if (request.tourId !== openTourId) return
      const answer = gotoRef.current(request.stepId)
      window.api.tourAnswerGoto({ requestId: request.requestId, ...answer })
    })
  }, [openTourId])

  // ── Asking ─────────────────────────────────────────────────────────────
  const askStateFor = useCallback(
    (stepId: string): TourCalloutAskState => {
      const local = localAsk[stepId]
      if (local && local.kind !== 'idle') {
        // A local "answering" (a new agent was asked) stands until the tour says otherwise.
        return local
      }
      const latest = [...(tour?.asks ?? [])]
        .reverse()
        .find((entry: TourAsk) => entry.stepId === stepId && entry.state !== 'cancelled')
      if (!latest) return { kind: 'idle' }
      const agentName = tour?.author.agentName ?? null
      if (latest.state === 'queued') return { kind: 'queued', askId: latest.id }
      if (latest.state === 'sent') return { kind: 'answering', agentName }
      if (latest.state === 'answered') return { kind: 'answered', agentName }
      if (latest.state === 'failed') return { kind: 'failed', message: latest.error ?? 'The question was not sent.' }
      return { kind: 'idle' }
    },
    [localAsk, tour],
  )

  const ask = useCallback(
    async (stepId: string, question: string) => {
      if (!workspaceId || !openTourId) return
      setLocalAsk((current) => ({ ...current, [stepId]: { kind: 'idle' } }))
      const result = await window.api.tourAsk(workspaceId, openTourId, stepId, question)
      if (result.ok) return
      setLocalAsk((current) => ({
        ...current,
        [stepId]: result.authorGone ? { kind: 'author-gone' } : { kind: 'failed', message: result.message },
      }))
    },
    [workspaceId, openTourId],
  )
  const askNewAgent = useCallback(
    async (stepId: string, question: string) => {
      if (!workspaceId || !openTourId || !question.trim()) return
      const result = await window.api.tourAskNewAgent(workspaceId, openTourId, stepId, question)
      // On success the service has the ask on record as sent, and the tour's
      // own state says "answering" until that agent's turn ends.
      setLocalAsk((current) => ({
        ...current,
        [stepId]: result.ok ? { kind: 'idle' } : { kind: 'failed', message: result.message },
      }))
    },
    [workspaceId, openTourId],
  )

  // ── Keys ───────────────────────────────────────────────────────────────
  const handleKey = useCallback(
    (event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; preventDefault: () => void }) => {
      if (!active) return false
      const action = tourKeyAction(event)
      if (!action) return false
      event.preventDefault()
      if (action === 'next') goNext()
      else goPrev()
      return true
    },
    [active, goNext, goPrev],
  )
  const stepByKeyRef = useRef<(direction: 'next' | 'prev') => void>(() => {})
  stepByKeyRef.current = (direction) => (direction === 'next' ? goNext() : goPrev())

  // ── Starting and leaving ───────────────────────────────────────────────
  // Whether the tour was already closed when the owner started it (replaying
  // one from the recent list). One the agent closes WHILE it plays ends the
  // playback; one that was closed to begin with plays like any other.
  const startedClosedRef = useRef(false)
  const start = useCallback(() => {
    if (!tour) return
    startedClosedRef.current = tour.closed
    const resume = tour.playback.currentStepId
      ? tour.steps.findIndex((entry) => entry.id === tour.playback.currentStepId)
      : -1
    setStarted(true)
    setPlay((current) => visit(current, tour.steps, resume >= 0 ? resume : 0))
    onTourSeen()
    // Start unmounts the button that had focus. The owner pressed it, so the
    // keyboard goes to the viewer it was pressed in — where `]` and `[` work —
    // rather than falling to the page.
    window.requestAnimationFrame(() => host?.closest<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true }))
  }, [tour, setStarted, setPlay, onTourSeen, host])
  // A tour that was playing when the viewer last unmounted resumes by itself.
  useEffect(() => {
    if (!tour || started || state.resumeRef.current !== tour.id) return
    state.resumeRef.current = null
    const resume = tour.playback.currentStepId
      ? tour.steps.findIndex((entry) => entry.id === tour.playback.currentStepId)
      : -1
    setStarted(true)
    setPlay((current) => visit(current, tour.steps, resume >= 0 ? resume : 0))
  }, [tour, started, state.resumeRef, setStarted, setPlay])
  useEffect(() => {
    onCurrentChange?.(openTourId ? { id: openTourId, playing: started } : null)
  }, [openTourId, started, onCurrentChange])
  const dismiss = useCallback(() => {
    onTourSeen()
    state.setOpenTourId(null)
  }, [onTourSeen, state])
  const leave = useCallback(() => {
    setStarted(false)
    setPlaying(false)
    state.setOpenTourId(null)
  }, [setStarted, state])
  useEffect(() => {
    if (tour?.closed && started && !startedClosedRef.current) leave()
  }, [tour?.closed, started, leave])

  // ── What is drawn ──────────────────────────────────────────────────────
  const progress: TourProgressMark[] = steps.map((entry, position) =>
    position === index
      ? 'current'
      : entry.status === 'gone'
        ? 'gone'
        : entry.status === 'moved'
          ? 'moved'
          : play.visited.includes(entry.id)
            ? 'visited'
            : 'ahead',
  )

  const strip =
    active && tour && index !== null ? (
      <TourStrip
        title={tour.title}
        index={index}
        count={steps.length}
        onStep={goTo}
        playing={playing}
        onTogglePlay={() => setPlaying((value) => !value)}
        follow={follow}
        onFollowChange={setFollow}
        listOpen={listOpen}
        onToggleList={() => setListOpen((value) => !value)}
        onClose={leave}
        pointer={
          pointer && pointerIndex >= 0 && pointerIndex !== index && !follow && pointer.at > pointerSeenAt
            ? { index: pointerIndex, onGo: () => goTo(pointerIndex) }
            : null
        }
        progress={progress}
      />
    ) : null

  const listItems: TourStepListItem[] = steps.map((entry) => ({
    id: entry.id,
    title: entry.title,
    file: entry.anchor.path.split('/').pop() ?? entry.anchor.path,
    ...(entry.hoverTip ? { hoverTip: entry.hoverTip } : {}),
    status: entry.status,
    visited: play.visited.includes(entry.id),
    kind: entry.kind,
  }))
  const stepList = active && listOpen ? <TourStepList steps={listItems} current={index} onSelect={goTo} /> : null

  const readyCard =
    tour && !started && tour.steps.length > 0 ? (
      <TourReadyCard
        title={tour.title}
        stepCount={tour.steps.length}
        fileCount={new Set(tour.steps.map((entry) => entry.anchor.path)).size}
        authorName={tour.author.agentName}
        overview={tour.overview ? renderMarkdown(tour.overview, { density: 'compact' }) : undefined}
        resumeAt={
          tour.playback.currentStepId ? tour.steps.findIndex((entry) => entry.id === tour.playback.currentStepId) : null
        }
        closed={tour.closed}
        onStart={start}
        onDismiss={dismiss}
      />
    ) : null

  const calloutFor = (entry: LiveTourStep, position: number, variant: 'zone' | 'card', visibleNow: boolean) => (
    <TourCallout
      index={position}
      count={steps.length}
      title={entry.title}
      kind={entry.kind}
      body={renderMarkdown(entry.body, { density: 'compact' })}
      location={tourStepLocation(entry)}
      status={entry.status}
      excerpt={entry.excerpt}
      visible={visibleNow}
      variant={variant}
      {...(position > 0 ? { onPrev: goPrev } : {})}
      {...(position < steps.length - 1 ? { onNext: goNext } : {})}
      ask={askStateFor(entry.id)}
      onAsk={(question) => void ask(entry.id, question)}
      onCancelQueued={(askId) => {
        if (workspaceId && openTourId) void window.api.tourCancelAsk(workspaceId, openTourId, askId)
      }}
      onAskNewAgent={(question) => void askNewAgent(entry.id, question)}
      onHoldChange={setHold}
      {...(variant === 'zone' ? { onResize: layer.reportHeight } : {})}
    />
  )

  const callout =
    layer.zoneNode && layerStep && index !== null
      ? createPortal(calloutFor(layerStep, index, 'zone', layer.calloutVisible), layer.zoneNode, `tour-${layerStep.id}`)
      : null

  // A step over a file with no text to point into stands as a card where the
  // editor would be.
  const fileCard =
    active && step && onStepFile && (contentState === 'binary' || contentState === 'too-large') && index !== null ? (
      <div className="absolute inset-0 z-[var(--z-float)] flex items-center justify-center bg-[color:var(--bg-app)] px-6">
        {calloutFor(step, index, 'card', true)}
      </div>
    ) : null

  // An agent's new tour, waiting because this viewer is busy or on screen.
  const offerChip = state.pendingOffer ? (
    <ChipButton className="shrink-0" onClick={state.takePendingOffer}>
      New tour ready →
    </ChipButton>
  ) : null

  return {
    active,
    offerChip,
    optionOverrides,
    swapping: active && swapping,
    strip,
    stepList,
    readyCard,
    callout,
    fileCard,
    handleKey,
    stepByKeyRef,
    renamedFrom: active && currentItem && isTourItem(currentItem) ? (currentItem.originalRelativePath ?? null) : null,
  }
}
