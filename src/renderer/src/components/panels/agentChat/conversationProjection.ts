// How a conversation's event log becomes the entries the chat renders:
// turns, tool calls, subagent lanes, approvals and questions.

import type {
  ConversationImageAttachment,
  ConversationApprovalKind,
  ConversationQuestion,
  ConversationSessionStatus,
  ConversationEvent,
} from '../../../../../shared/conversation-runtime'

// ── Pure projection ─────────────────────────────────────────────────────────

// One tool call in a turn's work timeline. A call the model made to spawn a
// background agent (Task/Agent) is a *lane*: `subagentLane` marks it, and the
// tool calls that ran inside that agent hang off it as `children` instead of
// flattening into the turn. Named separately from the union because the type
// is recursive (an agent can spawn an agent).
export type TranscriptToolEntry = {
  kind: 'tool'
  id: string
  turnId: string
  name: string
  status: 'running' | 'done'
  output?: string
  // One-line input summary from the provider (e.g. "Bash: npm test") —
  // the row reads as "what it did", not just the tool name.
  summary?: string
  startedAt?: number
  completedAt?: number
  // Line-count chips for edit-shaped tools (shipped by the adapter).
  addedLines?: number
  removedLines?: number
  // Set by the provider on the spawning call; true means this row is a lane
  // header whose elapsed time spans the whole subagent run.
  subagentLane?: boolean
  // Which kind of agent was spawned ('Explore', 'general-purpose', a custom
  // agent id) when the call named one; the lane's label.
  subagentType?: string
  // The lane this call ran inside, when it is a subagent's own tool call.
  parentToolUseId?: string
  // Tool calls made inside this lane, in the order they started.
  children?: TranscriptToolEntry[]
}

export type TranscriptEntry =
  | {
      kind: 'user'
      id: string
      text: string
      // Images the user attached to this turn (D3/1774). Live-only: they come
      // from the local send, never from the replayed transcript, so a bubble
      // restored after a restart is text-only by design.
      attachments?: ConversationImageAttachment[]
    }
  | {
      kind: 'assistant'
      turnId: string
      text: string
      reasoning: string
      status: 'streaming' | 'complete' | 'failed' | 'interrupted'
      failureReason?: string
      // Full provider failure message (payload `message`), for the error
      // block's "Show details" disclosure; failureReason is the short code.
      failureDetail?: string
      startedAt?: number
      completedAt?: number
      // Model the turn actually ran on (from the turn's events), for the byline.
      modelId?: string
      // First reasoning_delta → first non-reasoning event; feeds "Thought for Ns".
      reasoningDurationMs?: number
    }
  | TranscriptToolEntry
  | {
      kind: 'approval'
      requestId: string
      turnId?: string
      summary: string
      // Tool name behind the request ("Bash", "Edit"…), so the permission card
      // can render the literal command instead of generic copy.
      action?: string
      status: 'pending' | 'approved' | 'denied' | 'cancelled'
      // Structured request cards: 'question' renders options as buttons,
      // 'plan' renders the plan text with approve/reject. Absent/'tool' is a
      // plain permission row.
      requestKind?: ConversationApprovalKind
      questions?: ConversationQuestion[]
      plan?: string
      // Answers chosen when a question card resolved (question → answer), so
      // the resolved card keeps showing what was picked — including on replay.
      answers?: Record<string, string>
    }

export type UserTurn = { id: string; text: string; attachments?: ConversationImageAttachment[] }

/** Token counts the session has reported so far; null until the first report. */
export type ConversationUsage = { inputTokens: number; outputTokens: number }

export type ConversationProjection = {
  sessionStatus: ConversationSessionStatus | 'idle'
  activeTurn: boolean
  awaitingApproval: boolean
  entries: TranscriptEntry[]
  usage: ConversationUsage | null
  lastError: string | null
  // Credential source the CLI child reported on init ('none' = subscription
  // login, the guaranteed path). Anything else means the session is billing
  // outside the subscription and the chat must say so.
  apiKeySource: string | null
}

export function readString(payload: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!payload) return undefined
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export function readNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readApprovalKind(payload: Record<string, unknown> | undefined): ConversationApprovalKind {
  const value = payload?.kind
  return value === 'question' || value === 'plan' ? value : 'tool'
}

export function readQuestions(payload: Record<string, unknown> | undefined): ConversationQuestion[] | undefined {
  const raw = payload?.questions
  if (!Array.isArray(raw)) return undefined
  const questions: ConversationQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.question !== 'string' || !record.question.trim()) continue
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return null
            const optionRecord = option as Record<string, unknown>
            if (typeof optionRecord.label !== 'string' || !optionRecord.label.trim()) return null
            return {
              label: optionRecord.label,
              ...(typeof optionRecord.description === 'string' ? { description: optionRecord.description } : {}),
            }
          })
          .filter((option): option is { label: string; description?: string } => option !== null)
      : []
    questions.push({
      question: record.question,
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      multiSelect: record.multiSelect === true,
      allowFreeText: record.allowFreeText !== false,
      options,
    })
  }
  return questions.length > 0 ? questions : undefined
}

export function readBoolean(payload: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = payload?.[key]
  return typeof value === 'boolean' ? value : undefined
}

export function readAnswers(payload: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const raw = payload?.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') answers[key] = value
  }
  return Object.keys(answers).length > 0 ? answers : undefined
}

export type TurnAccumulator = {
  turnId: string
  text: string
  reasoning: string
  status: 'streaming' | 'complete' | 'failed' | 'interrupted'
  failureReason?: string
  failureDetail?: string
  startedAt?: number
  completedAt?: number
  modelId?: string
  reasoningStartedAt?: number
  reasoningEndedAt?: number
  // Every tool call of the turn keyed by call id, subagent children included;
  // nesting into lanes happens once, when the transcript entries are built.
  tools: Map<string, ToolAccumulator>
  approvals: string[]
}

export type ToolAccumulator = {
  id: string
  // The turn this call was reported on — not necessarily its lane's turn.
  turnId: string
  name: string
  status: 'running' | 'done'
  output?: string
  summary?: string
  startedAt?: number
  completedAt?: number
  addedLines?: number
  removedLines?: number
  subagentLane?: boolean
  subagentType?: string
  parentToolUseId?: string
}

export const SESSION_STATUS_BY_EVENT: Partial<Record<ConversationEvent['type'], ConversationSessionStatus>> = {
  session_started: 'starting',
  session_ready: 'ready',
  session_closed: 'stopped',
}

// Optimistic bubble for a send whose `user_message` event has not arrived yet.
export function userEntryFromLocalTurn(userTurn: UserTurn): Extract<TranscriptEntry, { kind: 'user' }> {
  return {
    kind: 'user',
    id: userTurn.id,
    text: userTurn.text,
    ...(userTurn.attachments?.length ? { attachments: userTurn.attachments } : {}),
  }
}

export function projectConversation(events: ConversationEvent[], userTurns: UserTurn[] = []): ConversationProjection {
  const turns = new Map<string, TurnAccumulator>()
  const turnOrder: string[] = []
  // User bubbles recorded in the event stream itself (persisted transcript);
  // when present these are authoritative and the locally tracked userTurns
  // only fill the optimistic gap between a send and its first event.
  const eventUserTurns = new Map<string, { id: string; text: string; localTurnId?: string }>()
  const representedLocalTurnIds = new Set<string>()
  // Attachments are live-only (D3/1774): the persisted `user_message` event
  // carries text alone, so the images a bubble shows are looked up from the
  // local send that produced it. After a restart there is no local send and the
  // replayed bubble is text-only — the documented v1 scope, not a silent drop.
  const localAttachments = new Map<string, ConversationImageAttachment[]>()
  for (const userTurn of userTurns) {
    if (userTurn.attachments?.length) localAttachments.set(userTurn.id, userTurn.attachments)
  }
  const approvals = new Map<string, Omit<Extract<TranscriptEntry, { kind: 'approval' }>, 'kind'>>()
  const approvalOrder: string[] = []
  // Every tool call of the session by call id. A subagent that finishes after
  // its turn's result reports over the continuation channel, so its calls (and
  // the lane's own closing output) carry a *different* turnId than the `Task`
  // call that spawned them — lookups must not be scoped to one turn.
  const toolsById = new Map<string, ToolAccumulator>()
  let sessionStatus: ConversationSessionStatus | 'idle' = 'idle'
  let usage: ConversationUsage | null = null
  let lastError: string | null = null
  let apiKeySource: string | null = null

  const ensureTurn = (turnId: string): TurnAccumulator => {
    let turn = turns.get(turnId)
    if (!turn) {
      turn = { turnId, text: '', reasoning: '', status: 'streaming', tools: new Map(), approvals: [] }
      turns.set(turnId, turn)
      turnOrder.push(turnId)
    }
    return turn
  }

  // The runtime/mock provider emits an interrupt as `turn_failed` with no
  // turnId, so resolve it against the latest turn still streaming.
  const latestActiveTurnId = (): string | undefined => {
    for (let i = turnOrder.length - 1; i >= 0; i -= 1) {
      const id = turnOrder[i]
      if (turns.get(id)?.status === 'streaming') return id
    }
    return undefined
  }

  // The reasoning window closes at the first non-reasoning signal of the turn.
  const closeReasoning = (turn: TurnAccumulator, at: number): void => {
    if (turn.reasoningStartedAt !== undefined && turn.reasoningEndedAt === undefined) {
      turn.reasoningEndedAt = at
    }
  }

  for (const event of events) {
    const sessionMapped = SESSION_STATUS_BY_EVENT[event.type]
    if (sessionMapped) sessionStatus = sessionMapped

    const turnId = readString(event.payload, 'turnId')
    switch (event.type) {
      case 'session_started': {
        // Each session binds credentials afresh; a previous session's reported
        // source must not carry over (a replayed transcript would otherwise
        // false-alarm the API-key banner after a restart).
        apiKeySource = null
        break
      }
      case 'session_updated': {
        const source = readString(event.payload, 'apiKeySource')
        if (source) apiKeySource = source
        break
      }
      case 'user_message': {
        if (turnId) {
          ensureTurn(turnId)
          const localTurnId = readString(event.payload, 'localTurnId')
          eventUserTurns.set(turnId, {
            id: event.id,
            text: readString(event.payload, 'text') ?? '',
            ...(localTurnId ? { localTurnId } : {}),
          })
          if (localTurnId) representedLocalTurnIds.add(localTurnId)
        }
        break
      }
      case 'turn_started': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          turn.status = 'streaming'
          turn.startedAt = turn.startedAt ?? event.createdAt
          if (event.modelId) turn.modelId = event.modelId
        }
        break
      }
      case 'content_delta': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          closeReasoning(turn, event.createdAt)
          turn.text += readString(event.payload, 'text', 'delta') ?? ''
        }
        break
      }
      case 'reasoning_delta': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          if (turn.reasoningStartedAt === undefined) turn.reasoningStartedAt = event.createdAt
          turn.reasoning += readString(event.payload, 'text', 'delta') ?? ''
        }
        break
      }
      case 'tool_started': {
        if (!turnId) break
        const turn = ensureTurn(turnId)
        closeReasoning(turn, event.createdAt)
        const id = readString(event.payload, 'callId', 'id', 'toolCallId') ?? `${turnId}:${turn.tools.size}`
        const tool: ToolAccumulator = {
          id,
          turnId,
          name: readString(event.payload, 'name', 'toolName', 'tool') ?? 'tool',
          status: 'running',
          summary: readString(event.payload, 'summary'),
          startedAt: event.createdAt,
          addedLines: readNumber(event.payload, 'addedLines'),
          removedLines: readNumber(event.payload, 'removedLines'),
          subagentLane: readBoolean(event.payload, 'subagentLane'),
          subagentType: readString(event.payload, 'subagentType'),
          parentToolUseId: readString(event.payload, 'parentToolUseId'),
        }
        turn.tools.set(id, tool)
        toolsById.set(id, tool)
        break
      }
      case 'tool_output': {
        if (!turnId) break
        const turn = ensureTurn(turnId)
        const id = readString(event.payload, 'callId', 'id', 'toolCallId')
        // A call id closes that exact call wherever it started — a lane opened
        // in an earlier turn closes on the continuation turn that carries its
        // result. Without an id, fall back inside the event's own turn and
        // lane: a subagent's output must never land on the parent's row.
        const parentToolUseId = readString(event.payload, 'parentToolUseId')
        const existing =
          (id && toolsById.get(id)) ||
          [...turn.tools.values()].filter((tool) => tool.parentToolUseId === parentToolUseId).at(-1)
        if (existing) {
          existing.status = 'done'
          existing.completedAt = event.createdAt
          existing.output = readString(event.payload, 'output', 'text') ?? existing.output
        }
        break
      }
      case 'approval_requested': {
        const requestId = readString(event.payload, 'requestId')
        if (!requestId) break
        const requestKind = readApprovalKind(event.payload)
        approvals.set(requestId, {
          requestId,
          turnId,
          summary: readString(event.payload, 'summary', 'action') ?? 'Approval requested.',
          action: readString(event.payload, 'action'),
          status: 'pending',
          requestKind,
          questions: requestKind === 'question' ? readQuestions(event.payload) : undefined,
          plan: requestKind === 'plan' ? (readString(event.payload, 'plan') ?? '') : undefined,
        })
        approvalOrder.push(requestId)
        if (turnId) ensureTurn(turnId).approvals.push(requestId)
        break
      }
      case 'approval_resolved': {
        const requestId = readString(event.payload, 'requestId')
        const approval = requestId ? approvals.get(requestId) : undefined
        if (approval) {
          const approved = event.payload?.approved === true
          approval.status = approved ? 'approved' : 'denied'
          approval.answers = readAnswers(event.payload)
        }
        break
      }
      case 'usage_updated': {
        // An event reports whichever counter moved, so a field it leaves out
        // keeps the count already accumulated rather than resetting it to zero.
        const previous: ConversationUsage = usage ?? { inputTokens: 0, outputTokens: 0 }
        usage = {
          inputTokens: readNumber(event.payload, 'inputTokens') ?? previous.inputTokens,
          outputTokens: readNumber(event.payload, 'outputTokens') ?? previous.outputTokens,
        }
        break
      }
      case 'turn_completed': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          closeReasoning(turn, event.createdAt)
          turn.status = 'complete'
          turn.completedAt = event.createdAt
        }
        break
      }
      case 'turn_failed': {
        const reason = readString(event.payload, 'reason', 'message')
        const interrupted = reason === 'interrupted'
        // Interrupts (and any failure event) can arrive without a turnId; apply
        // them to the latest streaming turn so Stop actually ends the active
        // turn instead of leaving the projection stuck in a responding state.
        const targetTurnId = turnId ?? latestActiveTurnId()
        if (targetTurnId) {
          const turn = ensureTurn(targetTurnId)
          closeReasoning(turn, event.createdAt)
          turn.status = interrupted ? 'interrupted' : 'failed'
          turn.failureReason = reason
          turn.failureDetail = readString(event.payload, 'message') ?? turn.failureDetail
          turn.completedAt = event.createdAt
          // A resolved turn can't keep a pending approval blocking the composer.
          for (const requestId of turn.approvals) {
            const approval = approvals.get(requestId)
            if (approval?.status === 'pending') approval.status = 'cancelled'
          }
        }
        if (!interrupted) lastError = reason ?? 'The turn failed.'
        break
      }
      default:
        break
    }
  }

  const activeTurn = turnOrder.some((id) => turns.get(id)?.status === 'streaming')
  const awaitingApproval = approvalOrder.some((id) => approvals.get(id)?.status === 'pending')

  // Interleave: each user turn precedes the assistant turn it triggered. When
  // the event stream carries `user_message` events (persisted transcripts),
  // those are authoritative and local userTurns only render the optimistic
  // tail (a send whose events have not arrived yet). Legacy streams without
  // user events fall back to index-pairing of local turns, which line up
  // because sends are blocked while a turn is active.
  const entries: TranscriptEntry[] = []
  const laneIndex = buildLaneIndex(
    turnOrder.map((id) => turns.get(id)).filter((turn): turn is TurnAccumulator => turn !== undefined),
    toolsById,
  )
  const useEventUserTurns = eventUserTurns.size > 0
  const blockCount = useEventUserTurns ? turnOrder.length : Math.max(turnOrder.length, userTurns.length)
  for (let i = 0; i < blockCount; i += 1) {
    const turnId = turnOrder[i]
    const eventUserTurn = turnId ? eventUserTurns.get(turnId) : undefined
    if (useEventUserTurns) {
      if (eventUserTurn) {
        const attachments = eventUserTurn.localTurnId ? localAttachments.get(eventUserTurn.localTurnId) : undefined
        entries.push({
          kind: 'user',
          id: eventUserTurn.id,
          text: eventUserTurn.text,
          ...(attachments ? { attachments } : {}),
        })
      }
    } else {
      const userTurn = userTurns[i]
      if (userTurn) entries.push(userEntryFromLocalTurn(userTurn))
    }
    if (!turnId) continue
    const turn = turns.get(turnId)
    if (!turn) continue
    entries.push({
      kind: 'assistant',
      turnId: turn.turnId,
      text: turn.text,
      reasoning: turn.reasoning,
      status: turn.status,
      failureReason: turn.failureReason,
      failureDetail: turn.failureDetail,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      modelId: turn.modelId,
      reasoningDurationMs:
        turn.reasoningStartedAt !== undefined && turn.reasoningEndedAt !== undefined
          ? Math.max(0, turn.reasoningEndedAt - turn.reasoningStartedAt)
          : undefined,
    })
    for (const tool of nestSubagentLanes(turn, laneIndex)) entries.push(tool)
    for (const requestId of turn.approvals) {
      const approval = approvals.get(requestId)
      if (approval) entries.push({ kind: 'approval', ...approval })
    }
  }
  // Optimistic tail: local sends not yet represented by user_message events.
  if (useEventUserTurns) {
    for (const userTurn of userTurns) {
      if (!representedLocalTurnIds.has(userTurn.id)) {
        entries.push(userEntryFromLocalTurn(userTurn))
      }
    }
  }
  // Approvals not attached to a known turn still need to surface.
  for (const requestId of approvalOrder) {
    const approval = approvals.get(requestId)
    if (approval && !approval.turnId) entries.push({ kind: 'approval', ...approval })
  }

  return { sessionStatus, activeTurn, awaitingApproval, entries, usage, lastError, apiKeySource }
}

// Index of which calls hang off which lane, built once per projection over
// every turn: a subagent's calls can land on a later continuation turn than the
// `Task` call that spawned them, and they still belong to that lane.
export type LaneIndex = {
  toolsById: Map<string, ToolAccumulator>
  childrenByParent: Map<string, ToolAccumulator[]>
  // Calls already emitted under a lane, so one never renders twice; also what
  // stops a cyclic parent chain (provider data, so untrusted) from recursing.
  claimed: Set<string>
}

export function buildLaneIndex(turns: TurnAccumulator[], toolsById: Map<string, ToolAccumulator>): LaneIndex {
  const childrenByParent = new Map<string, ToolAccumulator[]>()
  for (const turn of turns) {
    for (const tool of turn.tools.values()) {
      const parentId = tool.parentToolUseId
      if (!parentId || parentId === tool.id || !toolsById.has(parentId)) continue
      const siblings = childrenByParent.get(parentId)
      if (siblings) siblings.push(tool)
      else childrenByParent.set(parentId, [tool])
    }
  }
  return { toolsById, childrenByParent, claimed: new Set() }
}

// Fold one turn's tool map into lane-nested transcript entries: a call whose
// `parentToolUseId` names a known call becomes that call's child instead of a
// sibling row. A child whose parent never arrived stays a top-level row —
// subagent work is never dropped just because its lane header is missing.
export function nestSubagentLanes(turn: TurnAccumulator, index: LaneIndex): TranscriptToolEntry[] {
  const { toolsById, childrenByParent, claimed } = index
  const build = (tool: ToolAccumulator): TranscriptToolEntry => {
    claimed.add(tool.id)
    const children = (childrenByParent.get(tool.id) ?? []).filter((child) => !claimed.has(child.id)).map(build)
    return {
      kind: 'tool',
      id: tool.id,
      turnId: tool.turnId,
      name: tool.name,
      status: tool.status,
      output: tool.output,
      summary: tool.summary,
      startedAt: tool.startedAt,
      completedAt: tool.completedAt,
      addedLines: tool.addedLines,
      removedLines: tool.removedLines,
      // A call that spawned children is a lane even if the provider did not
      // stamp the flag (older event streams, or a renamed spawn tool).
      ...(tool.subagentLane || children.length > 0 ? { subagentLane: true } : {}),
      ...(tool.subagentType ? { subagentType: tool.subagentType } : {}),
      ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
      ...(children.length > 0 ? { children } : {}),
    }
  }

  const rows: TranscriptToolEntry[] = []
  for (const tool of turn.tools.values()) {
    const parentId = tool.parentToolUseId
    if (parentId && parentId !== tool.id && toolsById.has(parentId)) continue
    if (claimed.has(tool.id)) continue
    rows.push(build(tool))
  }
  return rows
}
