import type { ConversationEvent } from '../../../../../shared/conversation-runtime'
import { isBackgroundLaunchAck } from '../../../../../shared/conversation/subagents'
import {
  openReasoningRun,
  projectConversation,
  readBoolean,
  readNumber,
  readString,
  type ConversationProjection,
  type TranscriptEntry,
  type TranscriptToolEntry,
  type UserTurn,
} from './conversationProjection'

type ReasoningWindow = { startedAt: number; endedAt?: number }

export type IncrementalConversationState = {
  projection: ConversationProjection
  userTurns: UserTurn[]
  // What has been folded: `events[0, length)`. The array can be longer than
  // that: a later state of the same lineage appended to it in place, or it is
  // the caller's array a batch was read from.
  events: readonly ConversationEvent[]
  length: number
  // Whether `events` belongs to this lineage, so an append may go into it in
  // place. A caller's array (a session snapshot) is never written to.
  ownsEvents: boolean
  reasoning: Map<string, ReasoningWindow>
  entryIndexes: Map<string, number>
  // Moves on every change except a streamed token. What is derived from the
  // transcript's shape (pending approvals, the latest failed turn, prompt
  // history) is keyed on it, so it is not recomputed per token.
  structureRevision: number
}

// A batch of appended events is applied one at a time while that stays cheap:
// a coalesced frame of tokens, or a hidden view catching up on a few steps.
// Past these bounds one fold of the whole log costs less than the refolds the
// batch would trigger (a reconnect, or a view that rested through a long turn).
const MAX_INCREMENTAL_BATCH = 512
const MAX_BATCH_REFOLDS = 8

// Within one batch the entries array is copied on its first write and written
// in place after that, so a frame of tokens copies it once, not once a token.
type Batch = { entries: TranscriptEntry[] | null }

function entryKey(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return `user:${entry.id}`
    case 'assistant':
      return `assistant:${entry.turnId}`
    case 'tool':
      return `tool:${entry.id}`
    case 'approval':
      return `approval:${entry.requestId}`
    case 'compaction':
      return `compaction:${entry.id}`
    case 'commandOutput':
      return `commandOutput:${entry.id}`
  }
}

function indexEntries(entries: TranscriptEntry[]): Map<string, number> {
  return new Map(entries.map((entry, index) => [entryKey(entry), index]))
}

function folded(state: Pick<IncrementalConversationState, 'events' | 'length'>): readonly ConversationEvent[] {
  return state.length === state.events.length ? state.events : state.events.slice(0, state.length)
}

// Each turn's latest reasoning run: a run closed by prose or a tool call is
// replaced by the next one, as the fold adds each closed run to its segment.
// A failure without a turn id (an interrupt) closes the latest turn still
// streaming, as the fold resolves it, so the two never disagree about whether
// a run is open.
function reasoningWindows(events: readonly ConversationEvent[]): Map<string, ReasoningWindow> {
  const windows = new Map<string, ReasoningWindow>()
  // Turns in the order the fold creates them, and whether each still streams.
  const streaming = new Map<string, boolean>()
  const close = (turnId: string, at: number) => {
    const window = windows.get(turnId)
    if (window && window.endedAt === undefined) window.endedAt = at
  }
  for (const event of events) {
    const turnId = readString(event.payload, 'turnId')
    if (!turnId) {
      if (event.type !== 'turn_failed') continue
      const active = [...streaming].findLast(([, live]) => live)?.[0]
      if (active === undefined) continue
      close(active, event.createdAt)
      streaming.set(active, false)
      continue
    }
    // Every event the fold opens a turn for; a resolved approval opens none.
    if (event.type !== 'approval_resolved' && !streaming.has(turnId)) streaming.set(turnId, true)
    if (event.type === 'turn_started') streaming.set(turnId, true)
    if (event.type === 'reasoning_delta' && !isOpen(windows.get(turnId)))
      windows.set(turnId, { startedAt: event.createdAt })
    else if (
      event.type === 'content_delta' ||
      event.type === 'tool_started' ||
      event.type === 'turn_completed' ||
      event.type === 'turn_failed'
    )
      close(turnId, event.createdAt)
    if (event.type === 'turn_completed' || event.type === 'turn_failed') streaming.set(turnId, false)
  }
  return windows
}

function isOpen(window: ReasoningWindow | undefined): window is ReasoningWindow {
  return window !== undefined && window.endedAt === undefined
}

function reuseTool(previous: TranscriptToolEntry, next: TranscriptToolEntry): TranscriptToolEntry {
  const oldChildren = previous.children ?? []
  const nextChildren = next.children ?? []
  const oldById = new Map(oldChildren.map((child) => [child.id, child]))
  const children = nextChildren.map((child) => {
    const old = oldById.get(child.id)
    return old ? reuseTool(old, child) : child
  })
  const { children: _old, ...oldFields } = previous
  const { children: _next, ...nextFields } = next
  if (
    JSON.stringify(oldFields) === JSON.stringify(nextFields) &&
    children.length === oldChildren.length &&
    children.every((child, index) => child === oldChildren[index])
  )
    return previous
  return { ...next, ...(next.children ? { children } : {}) }
}

function reconcileEntries(previous: TranscriptEntry[], next: TranscriptEntry[]): TranscriptEntry[] {
  const oldByKey = new Map(previous.map((entry) => [entryKey(entry), entry]))
  return next.map((entry) => {
    const old = oldByKey.get(entryKey(entry))
    if (!old || old.kind !== entry.kind) return entry
    if (old.kind === 'tool' && entry.kind === 'tool') return reuseTool(old, entry)
    return JSON.stringify(old) === JSON.stringify(entry) ? old : entry
  })
}

export function createConversationProjectionState(
  events: readonly ConversationEvent[] = [],
  userTurns: UserTurn[] = [],
): IncrementalConversationState {
  const projection = projectConversation(events, userTurns)
  return {
    projection,
    userTurns,
    events,
    length: events.length,
    ownsEvents: false,
    reasoning: reasoningWindows(events),
    entryIndexes: indexEntries(projection.entries),
    structureRevision: 0,
  }
}

// Fold `events` whole, keeping the identity of every entry that came out the
// same, so rows that did not change are not re-rendered.
function rebuild(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  userTurns: UserTurn[],
  ownsEvents: boolean,
  batch: Batch | null = null,
): IncrementalConversationState {
  const next = createConversationProjectionState(events, userTurns)
  const entries = reconcileEntries(state.projection.entries, next.projection.entries)
  if (batch) batch.entries = entries
  return {
    ...next,
    ownsEvents,
    projection: { ...next.projection, entries },
    entryIndexes: indexEntries(entries),
    structureRevision: state.structureRevision + 1,
  }
}

function writableEntries(state: IncrementalConversationState, batch: Batch | null): TranscriptEntry[] {
  if (batch && batch.entries === state.projection.entries) return batch.entries
  const entries = state.projection.entries.slice()
  if (batch) batch.entries = entries
  return entries
}

function updateEntry(
  state: IncrementalConversationState,
  key: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
  batch: Batch | null,
): ConversationProjection | null {
  const index = state.entryIndexes.get(key)
  if (index === undefined) return null
  const entry = state.projection.entries[index]
  if (!entry) return null
  const updated = update(entry)
  if (updated === entry) return null
  const entries = writableEntries(state, batch)
  entries[index] = updated
  return { ...state.projection, entries }
}

function updateToolTree(tool: TranscriptToolEntry, id: string, event: ConversationEvent): TranscriptToolEntry | null {
  if (tool.id === id) {
    return {
      ...tool,
      status: event.payload?.partial === true ? tool.status : 'done',
      completedAt: event.payload?.partial === true ? tool.completedAt : event.createdAt,
      output: readString(event.payload, 'preview', 'output', 'text') ?? tool.output,
      truncated: readBoolean(event.payload, 'truncated') ?? tool.truncated,
      totalBytes: readNumber(event.payload, 'totalBytes') ?? tool.totalBytes,
      outputStatus: (() => {
        const status = event.payload?.status
        return status === 'ok' || status === 'error' || status === 'declined' || status === 'stopped'
          ? status
          : tool.outputStatus
      })(),
      exitCode: readNumber(event.payload, 'exitCode') ?? tool.exitCode,
      mime: readString(event.payload, 'mime') ?? tool.mime,
    }
  }
  if (!tool.children) return null
  for (let index = 0; index < tool.children.length; index++) {
    const child = updateToolTree(tool.children[index], id, event)
    if (child) {
      const children = tool.children.slice()
      children[index] = child
      return { ...tool, children }
    }
  }
  return null
}

function fastProjection(
  state: IncrementalConversationState,
  event: ConversationEvent,
  batch: Batch | null,
): ConversationProjection | null {
  const turnId = readString(event.payload, 'turnId')
  // A notice rides on whichever event followed it; only the fold reads it.
  if (readString(event.payload, 'notice')) return null
  if ((event.type === 'content_delta' || event.type === 'reasoning_delta') && turnId) {
    const delta = readString(event.payload, 'text', 'delta') ?? ''
    const key = `assistant:${turnId}`
    // An unknown turn needs the fold to create its entry, even from an empty delta.
    if (!state.entryIndexes.has(key)) return null
    // An empty content delta still ends the reasoning window, exactly as the
    // fold does, so it is not a no-op.
    return (
      updateEntry(
        state,
        key,
        (entry) => {
          if (entry.kind !== 'assistant') return entry
          const window = state.reasoning.get(turnId)
          if (event.type === 'reasoning_delta') {
            if (isOpen(window)) return delta ? { ...entry, reasoning: entry.reasoning + delta } : entry
            return { ...entry, reasoning: openReasoningRun(entry.reasoning, delta), reasoningLive: true }
          }
          const reasoningDurationMs = isOpen(window)
            ? (entry.reasoningDurationMs ?? 0) + Math.max(0, event.createdAt - window.startedAt)
            : entry.reasoningDurationMs
          if (!delta && reasoningDurationMs === entry.reasoningDurationMs && !entry.reasoningLive) return entry
          return { ...entry, text: entry.text + delta, reasoningDurationMs, reasoningLive: undefined }
        },
        batch,
      ) ?? state.projection
    )
  }
  if (event.type === 'tool_output') {
    const id = readString(event.payload, 'toolUseId', 'callId', 'id', 'toolCallId')
    if (!id) return null
    // A background agent's launch notice keeps its lane open; only the fold
    // knows how to read one.
    if (isBackgroundLaunchAck(readString(event.payload, 'preview', 'output', 'text'))) return null
    if (turnId && !state.entryIndexes.has(`assistant:${turnId}`)) return null
    for (let index = 0; index < state.projection.entries.length; index++) {
      const entry = state.projection.entries[index]
      if (entry.kind !== 'tool') continue
      const changed = updateToolTree(entry, id, event)
      if (!changed) continue
      const entries = writableEntries(state, batch)
      entries[index] = changed
      return { ...state.projection, entries }
    }
  }
  return null
}

// Whether an event can take the fast path, as far as its type says; only for
// sizing a batch, so a guess either way costs time, never correctness.
function mayApplyFast(event: ConversationEvent): boolean {
  return event.type === 'content_delta' || event.type === 'reasoning_delta' || event.type === 'tool_output'
}

// Fold `events[index]` into a state that holds `events[0, index)`.
function step(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  index: number,
  ownsEvents: boolean,
  batch: Batch | null,
): IncrementalConversationState {
  const event = events[index]!
  const length = index + 1
  const projection = fastProjection(state, event, batch)
  if (projection) {
    let reasoning = state.reasoning
    const turnId = readString(event.payload, 'turnId')
    if (turnId && event.type === 'reasoning_delta' && !isOpen(reasoning.get(turnId))) {
      reasoning = new Map(reasoning).set(turnId, { startedAt: event.createdAt })
    } else if (turnId && event.type === 'content_delta') {
      const window = reasoning.get(turnId)
      if (window && window.endedAt === undefined)
        reasoning = new Map(reasoning).set(turnId, { ...window, endedAt: event.createdAt })
    }
    const token = event.type === 'content_delta' || event.type === 'reasoning_delta'
    return {
      ...state,
      events,
      length,
      ownsEvents,
      projection,
      reasoning,
      structureRevision: token ? state.structureRevision : state.structureRevision + 1,
    }
  }
  const prefix = length === events.length ? events : events.slice(0, length)
  return rebuild(state, prefix, state.userTurns, ownsEvents && prefix === events, batch)
}

export function applyEvent(
  state: IncrementalConversationState,
  event: ConversationEvent,
): IncrementalConversationState {
  // Append in place when this state is its lineage's tip; a branch (or a
  // caller's array) is copied once, and owned from then on.
  const events =
    state.ownsEvents && state.events.length === state.length
      ? (state.events as ConversationEvent[])
      : state.events.slice(0, state.length)
  events.push(event)
  return step(state, events, state.length, true, null)
}

export function prependEvents(
  state: IncrementalConversationState,
  olderEvents: ConversationEvent[],
): IncrementalConversationState {
  if (!olderEvents.length) return state
  return rebuild(state, [...olderEvents, ...folded(state)], state.userTurns, true)
}

// Events appended after what `state` holds: token by token while the batch is
// small, else one fold of the whole log.
function applyAppended(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
): IncrementalConversationState {
  const start = state.length
  if (events.length - start === 1) return step(state, events, start, false, null)
  if (events.length - start <= MAX_INCREMENTAL_BATCH) {
    let refolds = 0
    for (let index = start; index < events.length && refolds <= MAX_BATCH_REFOLDS; index++)
      if (!mayApplyFast(events[index]!)) refolds++
    if (refolds <= MAX_BATCH_REFOLDS) {
      const batch: Batch = { entries: null }
      let next = state
      for (let index = start; index < events.length; index++) next = step(next, events, index, false, batch)
      return next
    }
  }
  return rebuild(state, events, state.userTurns, false)
}

/** Reconcile a paged snapshot or live window without replaying each snapshot event. */
export function syncConversationProjection(
  state: IncrementalConversationState,
  events: readonly ConversationEvent[],
  userTurns: UserTurn[],
): IncrementalConversationState {
  if (state.userTurns !== userTurns) return rebuild(state, events, userTurns, false)
  const oldLength = state.length
  if (events === state.events && events.length === oldLength) return state
  const last = oldLength > 0 ? state.events[oldLength - 1] : undefined
  if (oldLength > 0 && events.length > oldLength && events[oldLength - 1] === last) return applyAppended(state, events)
  // Anything else — a page of earlier turns, a log compacted or replaced — is
  // folded whole, keeping the rows that came out the same.
  if (events.length !== oldLength || (oldLength > 0 && events.at(-1) !== last))
    return rebuild(state, events, userTurns, false)
  return state
}
