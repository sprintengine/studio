import type { ConversationEvent } from '../../../../../shared/conversation-runtime'
import {
  projectConversation,
  readBoolean,
  readNumber,
  readString,
  type ConversationProjection,
  type TranscriptEntry,
  type TranscriptToolEntry,
  type UserTurn,
} from './conversationProjection'

type HistoryNode = { event: ConversationEvent; previous: HistoryNode | null; length: number }
type ReasoningWindow = { startedAt: number; endedAt?: number }

export type IncrementalConversationState = {
  projection: ConversationProjection
  userTurns: UserTurn[]
  history: HistoryNode | null
  reasoning: Map<string, ReasoningWindow>
  entryIndexes: Map<string, number>
}

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
  }
}

function indexEntries(entries: TranscriptEntry[]): Map<string, number> {
  return new Map(entries.map((entry, index) => [entryKey(entry), index]))
}

function collectHistory(history: HistoryNode | null): ConversationEvent[] {
  const events = new Array<ConversationEvent>(history?.length ?? 0)
  for (let node = history; node; node = node.previous) events[node.length - 1] = node.event
  return events
}

function reasoningWindows(events: ConversationEvent[]): Map<string, ReasoningWindow> {
  const windows = new Map<string, ReasoningWindow>()
  for (const event of events) {
    const turnId = readString(event.payload, 'turnId')
    if (!turnId) continue
    if (event.type === 'reasoning_delta' && !windows.has(turnId)) windows.set(turnId, { startedAt: event.createdAt })
    else if (
      event.type === 'content_delta' ||
      event.type === 'tool_started' ||
      event.type === 'turn_completed' ||
      event.type === 'turn_failed'
    ) {
      const window = windows.get(turnId)
      if (window && window.endedAt === undefined) {
        window.endedAt = event.createdAt
      }
    }
  }
  return windows
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
  events: ConversationEvent[] = [],
  userTurns: UserTurn[] = [],
): IncrementalConversationState {
  let history: HistoryNode | null = null
  let length = 0
  for (const event of events) history = { event, previous: history, length: ++length }
  const projection = projectConversation(events, userTurns)
  return {
    projection,
    userTurns,
    history,
    reasoning: reasoningWindows(events),
    entryIndexes: indexEntries(projection.entries),
  }
}

function updateEntry(
  state: IncrementalConversationState,
  key: string,
  update: (entry: TranscriptEntry) => TranscriptEntry,
): ConversationProjection | null {
  const index = state.entryIndexes.get(key)
  if (index === undefined) return null
  const entry = state.projection.entries[index]
  if (!entry) return null
  const updated = update(entry)
  if (updated === entry) return null
  const entries = state.projection.entries.slice()
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

function fastProjection(state: IncrementalConversationState, event: ConversationEvent): ConversationProjection | null {
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
      updateEntry(state, key, (entry) => {
        if (entry.kind !== 'assistant') return entry
        if (event.type === 'reasoning_delta') return delta ? { ...entry, reasoning: entry.reasoning + delta } : entry
        const window = state.reasoning.get(turnId)
        const reasoningDurationMs =
          window && window.endedAt === undefined
            ? Math.max(0, event.createdAt - window.startedAt)
            : entry.reasoningDurationMs
        if (!delta && reasoningDurationMs === entry.reasoningDurationMs) return entry
        return { ...entry, text: entry.text + delta, reasoningDurationMs }
      }) ?? state.projection
    )
  }
  if (event.type === 'tool_output') {
    const id = readString(event.payload, 'toolUseId', 'callId', 'id', 'toolCallId')
    if (!id) return null
    if (turnId && !state.entryIndexes.has(`assistant:${turnId}`)) return null
    for (let index = 0; index < state.projection.entries.length; index++) {
      const entry = state.projection.entries[index]
      if (entry.kind !== 'tool') continue
      const changed = updateToolTree(entry, id, event)
      if (!changed) continue
      const entries = state.projection.entries.slice()
      entries[index] = changed
      return { ...state.projection, entries }
    }
  }
  return null
}

export function applyEvent(
  state: IncrementalConversationState,
  event: ConversationEvent,
): IncrementalConversationState {
  const history: HistoryNode = { event, previous: state.history, length: (state.history?.length ?? 0) + 1 }
  const projection = fastProjection(state, event)
  if (projection) {
    let reasoning = state.reasoning
    const turnId = readString(event.payload, 'turnId')
    if (turnId && event.type === 'reasoning_delta' && !reasoning.has(turnId)) {
      reasoning = new Map(reasoning).set(turnId, { startedAt: event.createdAt })
    } else if (turnId && event.type === 'content_delta') {
      const window = reasoning.get(turnId)
      if (window && window.endedAt === undefined)
        reasoning = new Map(reasoning).set(turnId, { ...window, endedAt: event.createdAt })
    }
    return { ...state, history, projection, reasoning }
  }
  const events = collectHistory(history)
  const folded = projectConversation(events, state.userTurns)
  const entries = reconcileEntries(state.projection.entries, folded.entries)
  return {
    ...state,
    history,
    projection: { ...folded, entries },
    reasoning: reasoningWindows(events),
    entryIndexes: indexEntries(entries),
  }
}

export function prependEvents(
  state: IncrementalConversationState,
  olderEvents: ConversationEvent[],
): IncrementalConversationState {
  if (!olderEvents.length) return state
  const events = [...olderEvents, ...collectHistory(state.history)]
  const rebuilt = createConversationProjectionState(events, state.userTurns)
  const entries = reconcileEntries(state.projection.entries, rebuilt.projection.entries)
  return { ...rebuilt, projection: { ...rebuilt.projection, entries }, entryIndexes: indexEntries(entries) }
}

/** Reconcile a paged snapshot or live window without replaying each snapshot event. */
export function syncConversationProjection(
  state: IncrementalConversationState,
  events: ConversationEvent[],
  userTurns: UserTurn[],
): IncrementalConversationState {
  const oldLength = state.history?.length ?? 0
  if (state.userTurns !== userTurns) return createConversationProjectionState(events, userTurns)
  if (oldLength > 0 && events.length > oldLength && events[oldLength - 1] === state.history?.event) {
    const appended = events.slice(oldLength)
    if (appended.length === 1) return applyEvent(state, appended[0])
    // A reconnect can deliver many structural events at once. Fold that batch
    // once, retaining existing row identities, instead of refolding per event.
    const rebuilt = createConversationProjectionState(events, userTurns)
    const entries = reconcileEntries(state.projection.entries, rebuilt.projection.entries)
    return { ...rebuilt, projection: { ...rebuilt.projection, entries }, entryIndexes: indexEntries(entries) }
  }
  if (oldLength > 0 && events.length > oldLength && events.at(-1) === state.history?.event)
    return prependEvents(state, events.slice(0, events.length - oldLength))
  if (events.length !== oldLength || (oldLength > 0 && events.at(-1) !== state.history?.event))
    return createConversationProjectionState(events, userTurns)
  return state
}
