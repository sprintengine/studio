import type { ConversationProjection, UserTurn } from './conversationProjection.js'
import { deriveConversationTimelineRows, type ConversationTimelineRow } from './conversationTimeline.js'
import {
  createConversationProjectionState,
  syncConversationProjection,
  type IncrementalConversationState,
} from './incrementalConversationProjection.js'
import type { ConversationEvent, ConversationWireEvent, ConversationWirePage } from './protocol.js'

// Follow one conversation and keep it as rows (phase 9 spec, 5.1): the
// non-visual half of a conversation view, for any client that holds a Studio
// connection. It takes whatever follows a conversation by its stream frames
// (an `@sprintengine/agent-sdk` client's `conversations`, or a test's double),
// holds the events it has seen, and answers the projection and the rows they
// fold into. Nothing here touches a DOM or a framework: a React view reads it
// with `useSyncExternalStore`, anything else with `subscribe`.
//
// The source resumes a dropped stream from its own cursor, so a follower sees
// a reset snapshot only when the server could not vouch for the cursor; a
// reset replaces what is held. Events are held in sequence order, each once,
// so a resend after a reconnect is not drawn twice.

/** A conversation, by its workspace and agent: the address any client may use. */
export type ConversationAddress = { workspaceId: string; agentId: string; workspaceRoot?: string }

/** A conversation's stream as it arrives over the wire: an event's `type` is any string there. */
export type ConversationFollowSourceFrame =
  | { type: 'snapshot'; page: ConversationWirePage; reset?: true; generation?: string }
  | { type: 'event'; event: ConversationWireEvent }
  | { type: 'synchronized'; seq: number; generation?: string }
  | { type: 'error'; message: string }

/** What a follower reads a conversation through. An agent SDK client's `conversations` is one. */
export type ConversationFollowSource = {
  follow(
    ref: ConversationAddress,
    options: { turnLimit?: number } | undefined,
    onFrame: (frame: ConversationFollowSourceFrame) => void,
  ): () => void
  loadEarlier(
    ref: ConversationAddress,
    beforeCursor: number,
    turnLimit?: number,
  ): Promise<({ ok: true } & { page: ConversationWirePage }) | { ok: false; message: string }>
}

// A wire event read as the projection's: a type the projection does not know
// is one it skips, so an event added to the contract later is read as nothing
// rather than refused.
const asEvents = (events: readonly ConversationWireEvent[]) => events as unknown as readonly ConversationEvent[]

export type ConversationFollowerState = {
  /** The events held, in sequence order. */
  events: readonly ConversationEvent[]
  projection: ConversationProjection
  rows: readonly ConversationTimelineRow[]
  /** The first snapshot and its fence have arrived. */
  hydrated: boolean
  /** Earlier turns exist than are held. */
  hasMore: boolean
  loadingEarlier: boolean
  /** Why the stream stopped, when it did. */
  error: string | null
}

export type ConversationFollower = {
  getState(): ConversationFollowerState
  subscribe(listener: () => void): () => void
  /** Page in the turns before the earliest held. */
  loadEarlier(): Promise<void>
  dispose(): void
}

const NO_USER_TURNS: UserTurn[] = []

function seqOf(event: ConversationEvent): number {
  return typeof event.seq === 'number' ? event.seq : -1
}

/** Merge two runs of events into one in sequence order, each sequence once. */
function merge(held: readonly ConversationEvent[], incoming: readonly ConversationEvent[]): ConversationEvent[] {
  const bySeq = new Map<number, ConversationEvent>()
  const unsequenced: ConversationEvent[] = []
  for (const event of [...held, ...incoming]) {
    const seq = seqOf(event)
    if (seq < 0) unsequenced.push(event)
    else bySeq.set(seq, event)
  }
  return [...[...bySeq.values()].sort((a, b) => seqOf(a) - seqOf(b)), ...unsequenced]
}

export function createConversationFollower(
  source: ConversationFollowSource,
  ref: ConversationAddress,
  options: { turnLimit?: number } = {},
): ConversationFollower {
  const listeners = new Set<() => void>()
  let projectionState: IncrementalConversationState = createConversationProjectionState()
  let previousRows: ConversationTimelineRow[] = []
  let beforeCursor: number | null = null
  let disposed = false
  let state: ConversationFollowerState = {
    events: [],
    projection: projectionState.projection,
    rows: [],
    hydrated: false,
    hasMore: false,
    loadingEarlier: false,
    error: null,
  }

  function publish(next: Partial<ConversationFollowerState> & { events?: readonly ConversationEvent[] }): void {
    if (disposed) return
    let { projection, rows } = state
    if (next.events && next.events !== state.events) {
      projectionState = syncConversationProjection(projectionState, next.events, NO_USER_TURNS)
      projection = projectionState.projection
      const derived = deriveConversationTimelineRows(projection.entries, projection.activeTurn, previousRows)
      previousRows = derived
      rows = derived
    }
    state = { ...state, ...next, projection, rows }
    for (const listener of [...listeners]) listener()
  }

  function takePage(page: ConversationWirePage): void {
    beforeCursor = page.beforeCursor
    publish({ events: merge([], asEvents(page.events)), hasMore: page.hasMore })
  }

  const stop = source.follow(
    ref,
    options.turnLimit === undefined ? undefined : { turnLimit: options.turnLimit },
    (frame) => {
      switch (frame.type) {
        case 'snapshot':
          // The first snapshot, or a reset: what is held is replaced.
          takePage(frame.page)
          return
        case 'event': {
          const [incoming] = asEvents([frame.event])
          const last = state.events.at(-1)
          if (last && seqOf(incoming) >= 0 && seqOf(incoming) <= seqOf(last)) return
          publish({ events: [...state.events, incoming] })
          return
        }
        case 'synchronized':
          publish({ hydrated: true, error: null })
          return
        case 'error':
          publish({ error: frame.message })
          return
      }
    },
  )

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async loadEarlier() {
      if (state.loadingEarlier || !state.hasMore || beforeCursor === null) return
      publish({ loadingEarlier: true })
      const answer = await source.loadEarlier(ref, beforeCursor, options.turnLimit)
      if (!answer.ok) {
        publish({ loadingEarlier: false, error: answer.message })
        return
      }
      beforeCursor = answer.page.beforeCursor
      publish({
        events: merge(asEvents(answer.page.events), state.events),
        hasMore: answer.page.hasMore,
        loadingEarlier: false,
      })
    },
    dispose() {
      disposed = true
      listeners.clear()
      stop()
    },
  }
}
