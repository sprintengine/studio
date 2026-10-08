import React, { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef } from 'react'

import type { ConversationEvent } from '../../../../../shared/conversation-runtime'
import { CloseIconButton, IconButton, OutlineButton } from '../../ui/Buttons'
import { EmptyState } from '../../ui/EmptyState'
import { InlineNotice } from '../../ui/InlineNotice'
import { KbdChord } from '../../ui/KbdChord'
import { Pager } from '../../ui/Pager'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Spinner } from '../../ui/Spinner'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { FOCUS_RING_INSET_CLASS } from '../../ui/tokens'
import { PauseGlyph, PlayGlyph } from '../../ui/TourGlyphs'
import { TourProgress, type TourProgressMark } from '../../ui/TourStrip'
import { createConversationProjectionState, syncConversationProjection } from './incrementalConversationProjection'
import type { UserTurn } from './conversationProjection'
import { ConversationRowFrame } from './conversationRowFrame'
import { deriveConversationTimelineRows } from './conversationTimeline'
import {
  buildReplayScript,
  initialReplayState,
  REPLAY_SPEEDS,
  ReplayClock,
  replayDelay,
  replayPromptIndex,
  replayReducer,
  type ReplayAction,
  type ReplaySpeed,
} from './conversationReplay'
import { prefersReducedMotion } from './reducedMotion'
import { SubagentTypesProvider } from './subagentStatus'
import { TimelineRow, type TimelineChrome } from './timelineRows'
import { hostPlatform } from '../../../clientCapabilities'

// The replay, drawn over the chat it replays. The live chat stays mounted and
// running beneath it (inert while the replay is up), so leaving puts the person
// back exactly where they were, and a turn that finishes meanwhile is there.

/** What the chat hands the replay: the whole log once it has it. */
export type ConversationReplaySource =
  { status: 'loading' } | { status: 'ready'; events: ConversationEvent[] } | { status: 'error'; message: string }

const NO_USER_TURNS: UserTurn[] = []

export function ConversationReplayView({
  source,
  title,
  assistantName,
  cli,
  onLeave,
}: {
  source: ConversationReplaySource
  title: string
  assistantName: string
  cli: string | null
  onLeave: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The replay takes focus so its keys work at once, and gives it back where
  // it found it. Read while rendering: the player, a child, takes focus in its
  // own effect, which runs before this one.
  const previousFocusRef = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
    const previous = previousFocusRef.current
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label={`Replay of ${title}`}
      data-conversation-replay=""
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          onLeave()
        }
      }}
      // design-tokens-allow: a focus target the replay takes itself (tabIndex -1), never a tab stop; a ring round the whole pane would mark nothing
      className="absolute inset-0 z-[var(--z-float)] flex flex-col bg-[color:var(--agent-surface)] focus:outline-none"
    >
      {source.status === 'ready' ? (
        <ReplayPlayer events={source.events} title={title} assistantName={assistantName} cli={cli} onLeave={onLeave} />
      ) : (
        <>
          <ReplayBand title={title} onLeave={onLeave} />
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            {source.status === 'loading' ? (
              <span className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
                <Spinner size={14} />
                Reading the whole conversation…
              </span>
            ) : (
              <div className="flex max-w-[420px] flex-col items-center gap-3">
                <InlineNotice tone="error" title="The conversation could not be read." detail={source.message} />
                <OutlineButton size="xs" onClick={onLeave}>
                  Leave replay
                </OutlineButton>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** The band's frame: the replay's name and the way out, with whatever else the state has room for. */
function ReplayBand({
  title,
  onLeave,
  children,
  progress,
}: {
  title: string
  onLeave: () => void
  children?: React.ReactNode
  progress?: readonly TourProgressMark[]
}) {
  return (
    <div className="relative flex h-control-lg shrink-0 items-center gap-2 bg-[color:var(--bg-surface)] px-3">
      <PlayGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />
      <span
        className="min-w-0 truncate text-body font-medium tracking-tight text-[color:var(--text-strong)]"
        title={title}
      >
        {`Replay · ${title}`}
      </span>
      {children ?? <span className="flex-1" />}
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[color:var(--border-subtle)]" />
      <Tooltip content="Leave replay (Esc)" placement="bottom">
        <CloseIconButton aria-label="Leave replay" onClick={onLeave} />
      </Tooltip>
      {progress ? <TourProgress marks={progress} /> : null}
    </div>
  )
}

const SPEED_ITEMS = REPLAY_SPEEDS.map((speed) => ({ value: String(speed), label: `${speed}×` }))

/** Keys that stay with the control they land on rather than driving the replay. */
function keyBelongsToControl(event: React.KeyboardEvent): boolean {
  const target = event.target as HTMLElement
  if ((event.key === ' ' || event.key === 'Enter') && target.closest('button, [role="switch"], [role="radio"]'))
    return true
  return event.key.startsWith('Arrow') && target.closest('[role="radiogroup"]') !== null
}

/** The player's keys. Esc, which leaves, is the replay's own and works while it loads. */
function replayActionForKey(key: string, continuous: boolean): ReplayAction | null {
  switch (key) {
    case ' ':
    case 'ArrowDown':
      return { type: 'toggle' }
    case 'ArrowRight':
      return { type: 'next' }
    case 'ArrowLeft':
    case 'ArrowUp':
      return { type: 'previous' }
    case 'Home':
      return { type: 'restart' }
    case 'End':
      return { type: 'end' }
    case 'a':
    case 'A':
      return { type: 'continuous', on: !continuous }
    case '1':
    case '2':
    case '4':
      return { type: 'speed', speed: Number(key) as ReplaySpeed }
    default:
      return null
  }
}

function ReplayPlayer({
  events,
  title,
  assistantName,
  cli,
  onLeave,
}: {
  events: ConversationEvent[]
  title: string
  assistantName: string
  cli: string | null
  onLeave: () => void
}) {
  const script = useMemo(() => buildReplayScript(events), [events])
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof initialReplayState>, action: ReplayAction) => replayReducer(script, current, action),
    script,
    initialReplayState,
  )
  // The player's clock: one tick per step, at the step's own delay.
  useEffect(() => {
    if (!state.playing) return
    const timer = setTimeout(() => dispatch({ type: 'tick' }), replayDelay(script, state))
    return () => clearTimeout(timer)
  }, [script, state])

  const clockRef = useRef<ReplayClock | null>(null)
  clockRef.current ??= new ReplayClock()
  const shown = useMemo(() => clockRef.current!.reveal(script, state.cursor, Date.now()), [script, state.cursor])
  const projectionRef = useRef(createConversationProjectionState())
  const projection = useMemo(() => {
    projectionRef.current = syncConversationProjection(projectionRef.current, shown, NO_USER_TURNS)
    return projectionRef.current.projection
  }, [shown])
  const previousRowsRef = useRef<ReturnType<typeof deriveConversationTimelineRows>>([])
  const rows = useMemo(() => {
    const next = deriveConversationTimelineRows(projection.entries, projection.activeTurn, previousRowsRef.current)
    previousRowsRef.current = next
    return next
  }, [projection.entries, projection.activeTurn])
  // A replay reads; it never sends, retries, rewinds or forks.
  const chrome = useMemo<TimelineChrome>(
    () => ({
      assistantName,
      onRetry: () => undefined,
      retryDisabled: true,
      conversationRunning: projection.activeTurn,
      platform: hostPlatform(),
      cli,
    }),
    [assistantName, cli, projection.activeTurn],
  )

  // Rows enter as they did live. A row stepped back past and shown again
  // enters again, so the room sees it arrive both times.
  const enteredRef = useRef(new Set<string>())
  useEffect(() => {
    const ids = new Set(rows.map((row) => row.id))
    for (const id of enteredRef.current) if (!ids.has(id)) enteredRef.current.delete(id)
  }, [rows])

  const { scrollerRef, endRef, anchorId, anchorRef, onScroll, onManualScroll, follow } = useReplayFollow(rows)
  const act = (action: ReplayAction) => {
    if (action.type !== 'pause' && action.type !== 'speed' && action.type !== 'continuous') follow()
    dispatch(action)
  }

  const promptIndex = replayPromptIndex(script, state.cursor)
  const promptCount = script.prompts.length
  const atEnd = state.cursor >= script.events.length
  const progress = useMemo<TourProgressMark[]>(
    () =>
      script.prompts.map((_, index) =>
        index + 1 < promptIndex ? 'visited' : index + 1 === promptIndex ? 'current' : 'ahead',
      ),
    [script.prompts, promptIndex],
  )
  const continuousId = useId()
  // Keys go to the player, so the player holds focus from the start.
  const playerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    playerRef.current?.focus({ preventScroll: true })
  }, [])

  if (promptCount === 0)
    return (
      <>
        <ReplayBand title={title} onLeave={onLeave} />
        <EmptyState title="Nothing to replay" body="This chat has no messages yet." />
      </>
    )

  return (
    <div
      ref={playerRef}
      tabIndex={-1}
      // design-tokens-allow: the player holds focus for its keys (tabIndex -1), never a tab stop; the keys are drawn in its foot
      className="flex min-h-0 flex-1 flex-col focus:outline-none"
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || keyBelongsToControl(event)) return
        const action = replayActionForKey(event.key, state.continuous)
        if (!action) return
        event.preventDefault()
        event.stopPropagation()
        act(action)
      }}
    >
      <ReplayBand title={title} onLeave={onLeave} progress={progress}>
        <Pager
          inline
          inlineNoun={promptCount === 1 ? 'message' : 'messages'}
          page={promptIndex}
          pageCount={promptCount}
          rangeLabel={`Message ${promptIndex} of ${promptCount}`}
          stepHint="← / →"
          ariaLabel="Messages in the replay"
          onPageChange={(page) => act({ type: page < promptIndex ? 'previous' : 'next' })}
        />
        <span className="flex-1" />
        <SegmentedControl
          size="sm"
          ariaLabel="Replay speed"
          items={SPEED_ITEMS}
          value={String(state.speed)}
          onChange={(value) => act({ type: 'speed', speed: Number(value) as ReplaySpeed })}
        />
        <span className="flex shrink-0 items-center gap-1.5">
          <Switch
            checked={state.continuous}
            onChange={(on) => act({ type: 'continuous', on })}
            ariaLabelledBy={continuousId}
          />
          <span id={continuousId} className="whitespace-nowrap text-meta text-[color:var(--text-muted)]">
            Don’t stop at messages
          </span>
        </span>
        <Tooltip
          content={
            state.playing ? 'Pause (Space)' : atEnd ? 'The replay has ended' : 'Play to the next message (Space)'
          }
          placement="bottom"
        >
          <IconButton
            aria-label={state.playing ? 'Pause replay' : 'Play replay'}
            pressed={state.playing}
            disabled={atEnd}
            onClick={() => act({ type: 'toggle' })}
          >
            {state.playing ? <PauseGlyph /> : <PlayGlyph />}
          </IconButton>
        </Tooltip>
      </ReplayBand>

      <SubagentTypesProvider value={projection.agentTypes}>
        {/* A tab stop so the replay scrolls from the keyboard too, ringed as the
            live transcript is: inset, on keyboard focus only. The player keeps
            its arrows, Space, Home and End; Page Up and Page Down are the log's. */}
        <div
          ref={scrollerRef}
          role="log"
          tabIndex={0}
          aria-label={`${title} conversation, replayed`}
          aria-live="off"
          onScroll={onScroll}
          onWheel={onManualScroll}
          onTouchMove={onManualScroll}
          className={`chat-column-gutter relative min-h-0 flex-1 overflow-y-auto py-4 focus:outline-none ${FOCUS_RING_INSET_CLASS}`}
        >
          <div className="space-y-1">
            {rows.map((row) => (
              <div key={row.id} ref={row.id === anchorId ? anchorRef : undefined} data-replay-row-kind={row.kind}>
                <ConversationRowFrame id={row.id} live seen={enteredRef.current} flash={false} onFlashEnd={noop}>
                  <TimelineRow row={row} chrome={chrome} />
                </ConversationRowFrame>
              </div>
            ))}
          </div>
          <div ref={endRef} aria-hidden />
          {/* Room below the last row, so the newest message can rise to the top
              of the view the way a sent one does, its reply filling in under it. */}
          <div aria-hidden className="h-full" />
        </div>
      </SubagentTypesProvider>

      <ReplayFoot playing={state.playing} atEnd={atEnd} />
    </div>
  )
}

function noop(): void {}

/**
 * Keep the replay in view: the newest message at the top of the view, then the
 * end of its reply as it grows past the bottom — until the person scrolls
 * themselves, which hands the view to them until they next move the replay.
 * However they scroll counts — a wheel, a drag of the scrollbar, Page Down —
 * so it is the scroll itself that is read, less the replay's own.
 */
function useReplayFollow(rows: readonly { id: string; kind: string }[]) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  // Where the replay is scrolling itself to, and how far off it still is,
  // until it gets there: a smooth scroll raises a scroll event a frame on its
  // way, none of them the person's.
  const ownScrollRef = useRef<{ to: number; distance: number } | null>(null)
  // The newest message's row, and which message that was at the last layout.
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const anchorSeenRef = useRef<string | null>(null)
  const anchorId = rows.findLast((row) => row.kind === 'user')?.id ?? null
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const end = endRef.current
    const movedOn = anchorId !== anchorSeenRef.current
    anchorSeenRef.current = anchorId
    if (movedOn) followingRef.current = true
    if (!scroller || !end || !followingRef.current) return
    const wanted = Math.max(anchorRef.current?.offsetTop ?? 0, end.offsetTop - scroller.clientHeight)
    // Where the scroll will actually stop, so the replay knows it has arrived.
    const top = Math.max(0, Math.min(wanted, scroller.scrollHeight - scroller.clientHeight))
    const distance = Math.abs(scroller.scrollTop - top)
    if (distance < 1) return
    ownScrollRef.current = { to: top, distance }
    // A new message glides up; a reply growing a line at a time does not.
    scroller.scrollTo({ top, behavior: movedOn && !prefersReducedMotion() ? 'smooth' : 'auto' })
  }, [rows, anchorId])
  return {
    scrollerRef,
    endRef,
    anchorId,
    anchorRef,
    onScroll: () => {
      const scroller = scrollerRef.current
      const own = ownScrollRef.current
      if (scroller && own) {
        // Closer to where the replay sent it than the step before: still the
        // replay's glide, done once it is there. A step back the other way is
        // the person taking the scroll over mid-glide.
        const distance = Math.abs(scroller.scrollTop - own.to)
        if (distance < 1) ownScrollRef.current = null
        else if (distance < own.distance) ownScrollRef.current = { to: own.to, distance }
        if (distance < own.distance) return
        ownScrollRef.current = null
      }
      followingRef.current = false
    },
    // A wheel or a finger is the person's whichever way it goes, the replay's
    // own glide included.
    onManualScroll: () => {
      ownScrollRef.current = null
      followingRef.current = false
    },
    follow: () => {
      followingRef.current = true
    },
  }
}

/** Where the composer was: what the keys do, and the end said in words. */
function ReplayFoot({ playing, atEnd }: { playing: boolean; atEnd: boolean }) {
  return (
    <div className="chat-column-gutter flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 pb-4 pt-2 text-meta text-[color:var(--text-muted)]">
      {atEnd ? <span className="text-[color:var(--text-default)]">End of the conversation</span> : null}
      <ReplayKeyHint keys={['Space']} label={playing ? 'Pause' : 'Play'} />
      <ReplayKeyHint keys={['→']} ariaLabel="Right arrow" label="Next message" />
      <ReplayKeyHint keys={['←']} ariaLabel="Left arrow" label="Previous message" />
      {atEnd ? <ReplayKeyHint keys={['Home']} label="From the start" /> : null}
      <ReplayKeyHint keys={['Esc']} label="Leave" />
    </div>
  )
}

function ReplayKeyHint({ keys, label, ariaLabel }: { keys: string[]; label: string; ariaLabel?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <KbdChord keys={keys} ariaLabel={ariaLabel} />
      {label}
    </span>
  )
}
