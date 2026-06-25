// AgentChatView — the chat runtime surface for conversation-backed standard
// agents (T6). It renders canonical ConversationEvents from the main runtime
// over the typed conversation IPC/preload path, and drives the session
// lifecycle: start, send a turn, stream assistant output, approve/deny tool
// requests, interrupt, stop, and retry. It deliberately has no terminal
// emulator dependency and no landing/hero — the first screen is the usable
// composer.
//
// `projectConversation` is a pure, DOM-free fold of the event stream plus the
// locally tracked user turns into an ordered transcript. It is unit-tested by
// AgentChatView.test.ts so the streaming/approval/interrupt/failure states have
// node-level coverage without rendering.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  ConversationEvent,
  ConversationSessionStatus,
} from '../../../../shared/conversation-runtime'
import type { ConversationProviderListEntry, ConversationProviderModel } from '../../../../shared/plugin-manifest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { renderMarkdown } from '../../utils/markdown'
import { GhostButton, Popover, PrimaryButton, StatusDot, Tooltip, TruncatedText, type Tone } from '../ui'

// ── Pure projection ─────────────────────────────────────────────────────────

export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant'
      turnId: string
      text: string
      reasoning: string
      status: 'streaming' | 'complete' | 'failed' | 'interrupted'
      failureReason?: string
      startedAt?: number
      completedAt?: number
    }
  | { kind: 'tool'; id: string; turnId: string; name: string; status: 'running' | 'done'; output?: string }
  | {
      kind: 'approval'
      requestId: string
      turnId?: string
      summary: string
      status: 'pending' | 'approved' | 'denied' | 'cancelled'
    }

export type UserTurn = { id: string; text: string }

export type ConversationProjection = {
  sessionStatus: ConversationSessionStatus | 'idle'
  activeTurn: boolean
  awaitingApproval: boolean
  entries: TranscriptEntry[]
  usage: { inputTokens: number; outputTokens: number } | null
  lastError: string | null
}

function readString(payload: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!payload) return undefined
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function readNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

type TurnAccumulator = {
  turnId: string
  text: string
  reasoning: string
  status: 'streaming' | 'complete' | 'failed' | 'interrupted'
  failureReason?: string
  startedAt?: number
  completedAt?: number
  tools: Map<string, { id: string; name: string; status: 'running' | 'done'; output?: string }>
  approvals: string[]
}

const SESSION_STATUS_BY_EVENT: Partial<Record<ConversationEvent['type'], ConversationSessionStatus>> = {
  session_started: 'starting',
  session_ready: 'ready',
  session_closed: 'stopped',
}

export function projectConversation(
  events: ConversationEvent[],
  userTurns: UserTurn[] = []
): ConversationProjection {
  const turns = new Map<string, TurnAccumulator>()
  const turnOrder: string[] = []
  const approvals = new Map<
    string,
    { requestId: string; turnId?: string; summary: string; status: 'pending' | 'approved' | 'denied' | 'cancelled' }
  >()
  const approvalOrder: string[] = []
  let sessionStatus: ConversationSessionStatus | 'idle' = 'idle'
  let usage: { inputTokens: number; outputTokens: number } | null = null
  let lastError: string | null = null

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

  for (const event of events) {
    const sessionMapped = SESSION_STATUS_BY_EVENT[event.type]
    if (sessionMapped) sessionStatus = sessionMapped

    const turnId = readString(event.payload, 'turnId')
    switch (event.type) {
      case 'turn_started': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          turn.status = 'streaming'
          turn.startedAt = turn.startedAt ?? event.createdAt
        }
        break
      }
      case 'content_delta': {
        if (turnId) ensureTurn(turnId).text += readString(event.payload, 'text', 'delta') ?? ''
        break
      }
      case 'reasoning_delta': {
        if (turnId) ensureTurn(turnId).reasoning += readString(event.payload, 'text', 'delta') ?? ''
        break
      }
      case 'tool_started': {
        if (!turnId) break
        const turn = ensureTurn(turnId)
        const id = readString(event.payload, 'callId', 'id', 'toolCallId') ?? `${turnId}:${turn.tools.size}`
        turn.tools.set(id, {
          id,
          name: readString(event.payload, 'name', 'toolName', 'tool') ?? 'tool',
          status: 'running',
        })
        break
      }
      case 'tool_output': {
        if (!turnId) break
        const turn = ensureTurn(turnId)
        const id = readString(event.payload, 'callId', 'id', 'toolCallId')
        const existing = (id && turn.tools.get(id)) || [...turn.tools.values()].at(-1)
        if (existing) {
          existing.status = 'done'
          existing.output = readString(event.payload, 'output', 'text') ?? existing.output
        }
        break
      }
      case 'approval_requested': {
        const requestId = readString(event.payload, 'requestId')
        if (!requestId) break
        approvals.set(requestId, {
          requestId,
          turnId,
          summary: readString(event.payload, 'summary', 'action') ?? 'Approval requested.',
          status: 'pending',
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
        }
        break
      }
      case 'usage_updated': {
        const previousUsage = usage
        usage = {
          inputTokens: readNumber(event.payload, 'inputTokens') ?? previousUsage?.inputTokens ?? 0,
          outputTokens: readNumber(event.payload, 'outputTokens') ?? previousUsage?.outputTokens ?? 0,
        }
        break
      }
      case 'turn_completed': {
        if (turnId) {
          const turn = ensureTurn(turnId)
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
          turn.status = interrupted ? 'interrupted' : 'failed'
          turn.failureReason = reason
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

  // Interleave: each user turn precedes the assistant turn it triggered. Sends
  // are blocked while a turn is active, so user turns and assistant turns line
  // up by index; a trailing user turn with no assistant block yet renders alone.
  const entries: TranscriptEntry[] = []
  const blockCount = Math.max(turnOrder.length, userTurns.length)
  for (let i = 0; i < blockCount; i += 1) {
    const userTurn = userTurns[i]
    if (userTurn) entries.push({ kind: 'user', id: userTurn.id, text: userTurn.text })
    const turnId = turnOrder[i]
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
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    })
    for (const tool of turn.tools.values()) {
      entries.push({ kind: 'tool', id: tool.id, turnId: turn.turnId, name: tool.name, status: tool.status, output: tool.output })
    }
    for (const requestId of turn.approvals) {
      const approval = approvals.get(requestId)
      if (approval) entries.push({ kind: 'approval', ...approval })
    }
  }
  // Approvals not attached to a known turn still need to surface.
  for (const requestId of approvalOrder) {
    const approval = approvals.get(requestId)
    if (approval && !approval.turnId) entries.push({ kind: 'approval', ...approval })
  }

  return { sessionStatus, activeTurn, awaitingApproval, entries, usage, lastError }
}

export function activeConversationStage(entries: TranscriptEntry[], activeTurn: boolean): 'idle' | 'thinking' | 'tool' | 'approval' | 'responding' {
  const latestPendingApproval = [...entries].reverse().find((entry) => entry.kind === 'approval' && entry.status === 'pending')
  if (latestPendingApproval) return 'approval'
  const latestRunningTool = [...entries].reverse().find((entry) => entry.kind === 'tool' && entry.status === 'running')
  if (latestRunningTool) return 'tool'
  if (!activeTurn) return 'idle'
  const latestAssistant = [...entries].reverse().find((entry) => entry.kind === 'assistant')
  if (latestAssistant?.kind === 'assistant' && latestAssistant.text.trim().length > 0) return 'responding'
  return 'thinking'
}

export type ConversationTimelineRow =
  | { kind: 'user'; id: string; entry: Extract<TranscriptEntry, { kind: 'user' }> }
  | { kind: 'assistant'; id: string; entry: Extract<TranscriptEntry, { kind: 'assistant' }> }
  | {
      kind: 'activity'
      id: string
      turnId: string
      reasoning: string
      reasoningStatus: Extract<TranscriptEntry, { kind: 'assistant' }>['status']
      tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
    }
  | { kind: 'approval'; id: string; entry: Extract<TranscriptEntry, { kind: 'approval' }> }
  | {
      kind: 'working'
      id: string
      stage: ReturnType<typeof activeConversationStage>
      label: string
      startedAt?: number
    }

const MAX_VISIBLE_TOOL_ROWS = 4

export function deriveConversationTimelineRows(
  entries: TranscriptEntry[],
  activeTurn: boolean,
): ConversationTimelineRow[] {
  const rows: ConversationTimelineRow[] = []
  const stage = activeConversationStage(entries, activeTurn)
  const latestAssistant = [...entries].reverse().find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant',
  )
  const pendingApproval = [...entries].reverse().find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval' && entry.status === 'pending',
  )

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.kind === 'user') {
      rows.push({ kind: 'user', id: `user:${entry.id}`, entry })
      continue
    }
    if (entry.kind === 'assistant') {
      const tools: Extract<TranscriptEntry, { kind: 'tool' }>[] = []
      let cursor = index + 1
      while (cursor < entries.length) {
        const next = entries[cursor]
        if (!next || next.kind !== 'tool' || next.turnId !== entry.turnId) break
        tools.push(next)
        cursor += 1
      }
      if (entry.reasoning.trim() || tools.length > 0) {
        rows.push({
          kind: 'activity',
          id: `activity:${entry.turnId}`,
          turnId: entry.turnId,
          reasoning: entry.reasoning,
          reasoningStatus: entry.status,
          tools,
        })
      }
      if (entry.text.trim() || entry.status === 'failed' || entry.status === 'interrupted') {
        rows.push({ kind: 'assistant', id: `assistant:${entry.turnId}`, entry })
      }
      index = cursor - 1
      continue
    }
    if (entry.kind === 'tool') {
      rows.push({
        kind: 'activity',
        id: `activity:${entry.turnId}:${entry.id}`,
        turnId: entry.turnId,
        reasoning: '',
        reasoningStatus: entry.status === 'running' ? 'streaming' : 'complete',
        tools: [entry],
      })
      continue
    }
    if (entry.kind === 'approval') {
      if (entry.status === 'pending') continue
      rows.push({ kind: 'approval', id: `approval:${entry.requestId}`, entry })
    }
  }

  if (stage !== 'idle' && !pendingApproval) {
    const runningTool = [...entries].reverse().find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool' && entry.status === 'running',
    )
    const label =
      stage === 'tool' && runningTool
        ? `Running ${runningTool.name}`
        : stage === 'responding'
          ? 'Streaming response'
          : 'Working'
    rows.push({
      kind: 'working',
      id: 'working-indicator-row',
      stage,
      label,
      startedAt: latestAssistant?.startedAt,
    })
  }

  return rows
}

// ── Readiness gating ────────────────────────────────────────────────────────

export type ChatReadiness =
  | { kind: 'loading' }
  | { kind: 'no-workspace-folder' }
  | { kind: 'provider-unavailable'; providerId: string }
  | { kind: 'model-unavailable'; providerId: string; modelId: string }
  | { kind: 'missing-key'; providerId: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

const READINESS_COPY: Record<Exclude<ChatReadiness['kind'], 'ready' | 'loading'>, string> = {
  'no-workspace-folder': 'Open a workspace folder before starting a conversation agent.',
  'provider-unavailable': 'This conversation provider is not installed. Reinstall it to use this agent.',
  'model-unavailable': 'The selected model is not offered by this provider. Pick another model in settings.',
  'missing-key': 'Add an API key for this provider in Settings → Providers before starting.',
  error: 'Conversation providers are unavailable.',
}

export function readinessLabel(readiness: ChatReadiness): string {
  if (readiness.kind === 'ready') return 'Ready'
  if (readiness.kind === 'loading') return 'Checking provider…'
  if (readiness.kind === 'error') return readiness.message
  return READINESS_COPY[readiness.kind]
}

// ── Component ───────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string
  agentId: string
}

// The bordered/rounded surface and focus ring live on the composer container;
// the textarea itself is transparent and borderless so the field reads as one
// piece with the footer control row beneath it.
const COMPOSER_CLASS =
  'min-h-[40px] w-full resize-none rounded-t-lg bg-transparent px-3 pb-1 pt-2.5 text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] disabled:opacity-45'

type PendingAction = 'starting' | 'sending' | 'stopping' | null

export function stopDisabledForPending(pending: PendingAction): boolean {
  return pending === 'stopping'
}

// The model is editable only until the conversation starts: the runtime binds a
// session to one provider/model, so once the user has sent a turn (or a session
// exists) the in-composer picker locks.
export function isConversationModelLocked(userTurnCount: number, sessionId: string | null): boolean {
  return userTurnCount > 0 || sessionId !== null
}

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'cancelled'

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = {
  pending: 'warn',
  approved: 'good',
  denied: 'error',
  cancelled: 'neutral',
}

const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Approval requested',
  approved: 'Approval · approved',
  denied: 'Approval · denied',
  cancelled: 'Approval · cancelled',
}

export default function AgentChatView({ workspaceId, agentId }: Props) {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const conversation = agent?.conversation
  const label = agent?.name ?? agentId
  const workspaceRoot = workspace?.folderPath ?? null

  const [readiness, setReadiness] = useState<ChatReadiness>({ kind: 'loading' })
  const [providers, setProviders] = useState<ConversationProviderListEntry[]>([])
  // Live model catalog for the current provider (e.g. OpenRouter's full list),
  // fetched lazily; empty until loaded, then preferred over the manifest seed.
  const [liveModels, setLiveModels] = useState<ConversationProviderModel[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [userTurns, setUserTurns] = useState<UserTurn[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Resolve provider/model/key readiness from the conversation IPC.
  useEffect(() => {
    let cancelled = false
    if (!conversation) return
    if (!workspaceRoot) {
      setReadiness({ kind: 'no-workspace-folder' })
      return
    }
    if (typeof window.api.conversationProvidersList !== 'function') {
      setReadiness({ kind: 'error', message: 'Conversation providers need an app restart before this agent is available.' })
      return
    }
    setReadiness({ kind: 'loading' })
    void (async () => {
      try {
        const list = await window.api.conversationProvidersList()
        if (cancelled) return
        if (!list.ok) {
          setReadiness({ kind: 'error', message: list.message })
          return
        }
        setProviders(list.providers)
        const provider = list.providers.find((entry) => entry.id === conversation.providerId)
        if (!provider) {
          setReadiness({ kind: 'provider-unavailable', providerId: conversation.providerId })
          return
        }
        // Providers with a live catalog accept models not in the static seed, so
        // membership is only enforced for static-only providers.
        if (!provider.supportsDynamicModels && !provider.models.some((model) => model.id === conversation.modelId)) {
          setReadiness({ kind: 'model-unavailable', providerId: conversation.providerId, modelId: conversation.modelId })
          return
        }
        const status = await window.api.conversationSecretStatus({ providerId: conversation.providerId })
        if (cancelled) return
        // A provider that declares no secret returns ok:false with that reason;
        // treat anything other than an explicit unconfigured key as ready.
        if (status.ok && !status.status.configured) {
          setReadiness({ kind: 'missing-key', providerId: conversation.providerId })
          return
        }
        setReadiness({ kind: 'ready' })
      } catch (err) {
        if (!cancelled) setReadiness({ kind: 'error', message: err instanceof Error ? err.message : 'Provider check failed.' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversation, workspaceRoot])

  // Subscribe to canonical events for this agent's session. Every event carries a
  // unique id, so we dedupe on it: a window holds one broadcast subscription per
  // open chat tab (and dev StrictMode double-invokes effects), which would
  // otherwise deliver — and append — each streamed token more than once, tripling
  // the text. Deduping on id makes the transcript immune to duplicate delivery.
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (typeof window.api.onConversationEvent !== 'function') return
    const unsubscribe = window.api.onConversationEvent((event) => {
      if (event.workspaceId !== workspaceId || event.agentId !== agentId) return
      if (seenEventIdsRef.current.has(event.id)) return
      seenEventIdsRef.current.add(event.id)
      setEvents((current) => [...current, event])
    })
    return unsubscribe
  }, [workspaceId, agentId])

  // Fetch the provider's live model catalog (keyed on provider, not model, so a
  // model switch within the same provider does not refetch). Failures are silent
  // — the picker falls back to the manifest seed models.
  useEffect(() => {
    const providerId = conversation?.providerId
    if (!providerId || typeof window.api.conversationProviderModels !== 'function') return
    let cancelled = false
    setLiveModels([])
    void window.api
      .conversationProviderModels({ providerId })
      .then((result) => {
        if (!cancelled && result.ok) setLiveModels(result.models)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [conversation?.providerId])

  const projection = useMemo(() => projectConversation(events, userTurns), [events, userTurns])
  const timelineRows = useMemo(
    () => deriveConversationTimelineRows(projection.entries, projection.activeTurn),
    [projection.entries, projection.activeTurn],
  )

  // Keep the newest message in view without jumping focus.
  useEffect(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [timelineRows.length, projection.activeTurn])

  // Surface turn failures (streamed via `turn_failed`) to the app Notifications
  // panel, deduped on the message so a single failure is logged once.
  const lastNotifiedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    const message = projection.lastError
    // Clear on recovery so an identical error on a later turn notifies again.
    if (!message) {
      lastNotifiedErrorRef.current = null
      return
    }
    if (message === lastNotifiedErrorRef.current) return
    lastNotifiedErrorRef.current = message
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} turn failed`,
      message,
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [projection.lastError, label, workspaceId, workspace?.name, agentId])

  // Surface session/send action errors (start failure, missing key, IPC error)
  // the same way — these never reach the event stream.
  const lastNotifiedActionErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (!actionError || actionError === lastNotifiedActionErrorRef.current) return
    lastNotifiedActionErrorRef.current = actionError
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} could not start`,
      message: actionError,
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [actionError, label, workspaceId, workspace?.name, agentId])

  // Self-heal an ugly tab name: spawn may have named the tab with the raw model
  // id (a remembered live-only model has no nice label until the catalog loads).
  // Once live models arrive, rename to the model's display name.
  useEffect(() => {
    if (!conversation) return
    const displayName = liveModels.find((model) => model.id === conversation.modelId)?.displayName
    if (displayName && agent?.name === conversation.modelId && displayName !== conversation.modelId) {
      updateAgent(workspaceId, agentId, { name: displayName })
    }
  }, [liveModels, conversation, agent?.name, updateAgent, workspaceId, agentId])

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId
    if (!conversation || !workspaceRoot) return null
    const result = await window.api.conversationSessionStart({
      workspaceRoot,
      workspaceId,
      agentId,
      providerId: conversation.providerId,
      modelId: conversation.modelId,
    })
    if (!result.ok) {
      setActionError(result.message)
      return null
    }
    setSessionId(result.session.sessionId)
    return result.session.sessionId
  }, [agentId, conversation, sessionId, workspaceId, workspaceRoot])

  const sendTurn = useCallback(
    async (message: string) => {
      const text = message.trim()
      if (!text || pending) return
      setActionError(null)
      setPending('starting')
      const activeSession = await ensureSession()
      if (!activeSession) {
        setPending(null)
        return
      }
      setUserTurns((current) => [...current, { id: `user-${current.length}-${Date.now()}`, text }])
      setDraft('')
      setPending('sending')
      try {
        const result = await window.api.conversationSessionSendTurn({ sessionId: activeSession, message: text })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not send the message.')
      } finally {
        setPending(null)
      }
    },
    [ensureSession, pending]
  )

  const resolveApproval = useCallback(
    async (requestId: string, approved: boolean) => {
      if (!sessionId) return
      setActionError(null)
      try {
        const result = await window.api.conversationSessionRespondToRequest({ sessionId, requestId, approved })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not record the approval.')
      }
    },
    [sessionId]
  )

  const interrupt = useCallback(async () => {
    if (!sessionId || pending === 'stopping') return
    setPending('stopping')
    try {
      const result = await window.api.conversationSessionInterrupt({ sessionId })
      if (!result.ok) setActionError(result.message)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not interrupt the turn.')
    } finally {
      setPending(null)
    }
  }, [sessionId, pending])

  const retry = useCallback(() => {
    const lastUser = [...userTurns].reverse()[0]
    if (lastUser) void sendTurn(lastUser.text)
  }, [sendTurn, userTurns])

  if (!conversation) {
    return (
      <ChatShell>
        <ChatNotice tone="error">This agent has no conversation provider selected.</ChatNotice>
      </ChatShell>
    )
  }

  const ready = readiness.kind === 'ready'
  const composerDisabled = !ready || projection.activeTurn || pending !== null
  const showRetry = projection.lastError !== null && !projection.activeTurn

  // The runtime binds a session to one provider/model, so the model is editable
  // only until the conversation starts: once a turn is sent or a session exists,
  // the pill is read-only and the user opens a new agent to change model.
  const modelLocked = isConversationModelLocked(userTurns.length, sessionId)
  // Picker groups: one per provider, using the live catalog for the current
  // provider when it has loaded, else that provider's manifest seed models.
  const modelGroups = providers.map((entry) => ({
    providerId: entry.id,
    providerLabel: entry.displayName,
    models: entry.id === conversation.providerId && liveModels.length > 0 ? liveModels : entry.models,
  }))
  const currentModel = modelGroups
    .find((group) => group.providerId === conversation.providerId)
    ?.models.find((model) => model.id === conversation.modelId)
  const currentModelLabel = currentModel?.displayName ?? conversation.modelId
  const contextLength = currentModel?.contextLength
  const usedTokens = projection.usage ? projection.usage.inputTokens + projection.usage.outputTokens : 0
  const selectModel = (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    if (modelLocked || (providerId === conversation.providerId && modelId === conversation.modelId)) return
    updateAgent(workspaceId, agentId, { conversation: { providerId, modelId } })
    setLastSelectedConversationModel({ providerId, modelId })
  }

  return (
    <ChatShell>
      {!ready ? (
        <ChatNotice tone={readiness.kind === 'loading' ? 'neutral' : 'warn'}>{readinessLabel(readiness)}</ChatNotice>
      ) : null}

      <div
        ref={listRef}
        role="log"
        aria-label={`${label} conversation`}
        aria-live="polite"
        className="flex-1 space-y-4 overflow-y-auto px-3 py-3"
      >
        {timelineRows.length === 0 ? (
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            {ready ? 'No messages yet. Send a prompt to start the conversation.' : 'Conversation is unavailable until the provider is ready.'}
          </p>
        ) : (
          timelineRows.map((row) => (
            <TimelineRow key={row.id} row={row} />
          ))
        )}
      </div>

      <div className="px-3 pb-3 pt-1">
        <ConversationPendingDock
          entries={projection.entries}
          onApprove={resolveApproval}
          busy={pending !== null}
        />

        {/*
         * A turn failure already states its reason in the transcript (and the
         * Notifications panel), so here we only restate text for action errors
         * that never reach the transcript (start/send/IPC). A failed turn just
         * gets a Retry — no third copy of the same message.
         */}
        {actionError ? (
          <div className="mb-2 flex items-center justify-between gap-3">
            <TruncatedText as="span" text={actionError} className="min-w-0 text-[12px] leading-5 text-[color:var(--tone-error)]" />
            {showRetry ? (
              <GhostButton
                size="sm"
                onClick={retry}
                disabled={composerDisabled}
                className="shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
              >
                Retry
              </GhostButton>
            ) : null}
          </div>
        ) : showRetry ? (
          <div className="mb-2 flex justify-end">
            <GhostButton
              size="sm"
              onClick={retry}
              disabled={composerDisabled}
              className="shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
            >
              Retry
            </GhostButton>
          </div>
        ) : null}

        {/*
         * Composer: a single rounded field that holds the textarea and a footer
         * control row (model pill + send), so the input reads as one surface.
         * The model lives here — picked before the first message, then locked.
         */}
        <div className="rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] transition-colors focus-within:border-[color:var(--accent-primary)]">
          <label htmlFor={`chat-composer-${agentId}`} className="sr-only">
            Message {label}
          </label>
          <textarea
            id={`chat-composer-${agentId}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendTurn(draft)
              }
            }}
            placeholder={ready ? 'Send a message…' : readinessLabel(readiness)}
            rows={1}
            disabled={composerDisabled}
            className={COMPOSER_CLASS}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
            <div className="flex min-w-0 items-center gap-1">
              <ModelPickerPill
                label={currentModelLabel}
                locked={modelLocked}
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                groups={modelGroups}
                selectedProviderId={conversation.providerId}
                selectedModelId={conversation.modelId}
                onSelect={selectModel}
              />
              {contextLength ? (
                <ContextMeter used={usedTokens} total={contextLength} />
              ) : null}
            </div>
            {projection.activeTurn ? (
              <ComposerActionButton
                tone="neutral"
                ariaLabel={pending === 'stopping' ? 'Stopping' : 'Stop responding'}
                onClick={() => void interrupt()}
                disabled={stopDisabledForPending(pending)}
              >
                <StopGlyph className="icon-sm" />
              </ComposerActionButton>
            ) : (
              <ComposerActionButton
                tone="accent"
                ariaLabel={pending === 'starting' || pending === 'sending' ? 'Sending' : 'Send message'}
                onClick={() => void sendTurn(draft)}
                disabled={composerDisabled || !draft.trim()}
              >
                <SendArrowGlyph className="icon-sm" />
              </ComposerActionButton>
            )}
          </div>
        </div>
      </div>
    </ChatShell>
  )
}

// The chat panel is header-less by design: the tab already names the agent, and
// model/session state live in the composer footer (shared layout). Repeating the name
// or model in a header is the duplication we're avoiding.
function ChatShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-[color:var(--agent-surface)] text-[12px] text-[color:var(--text-default)]">
      {children}
    </div>
  )
}

// Compact context-window meter: a ring that fills as the conversation consumes
// the model's context, plus "used / total" in tokens. Shown only when the
// provider reports a context length (e.g. OpenRouter's `context_length`).
function ContextMeter({ used, total }: { used: number; total: number }) {
  const fraction = Math.max(0, Math.min(1, total > 0 ? used / total : 0))
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const nearFull = fraction >= 0.9
  return (
    <Tooltip content={`Context used: ${used.toLocaleString()} / ${total.toLocaleString()} tokens`} placement="top">
      <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-[color:var(--text-muted)]">
        <svg className="icon-sm -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={nearFull ? 'var(--tone-warn)' : 'var(--accent-primary)'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
        {formatTokens(total)}
      </span>
    </Tooltip>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

// The in-composer model selector. Before the conversation starts it is a pill
// that opens a grouped provider → model menu; once locked it renders as static
// muted text (the session is bound to its model).
type ModelGroup = { providerId: string; providerLabel: string; models: ConversationProviderModel[] }

function ModelPickerPill({
  label,
  locked,
  open,
  onOpenChange,
  groups,
  selectedProviderId,
  selectedModelId,
  onSelect,
}: {
  label: string
  locked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ModelGroup[]
  selectedProviderId: string
  selectedModelId: string
  onSelect: (providerId: string, modelId: string) => void
}) {
  const [query, setQuery] = useState('')
  if (locked) {
    return (
      <Tooltip content="Model is fixed once the conversation starts" placement="top">
        <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[color:var(--text-muted)]">
          <ChatGlyph className="icon-sm text-[color:var(--text-subtle)]" />
          <span className="max-w-[200px] truncate">{label}</span>
        </span>
      </Tooltip>
    )
  }
  const normalized = query.trim().toLowerCase()
  const filtered = groups
    .map((group) => ({
      ...group,
      models: normalized
        ? group.models.filter(
            (model) =>
              model.id.toLowerCase().includes(normalized)
              || (model.displayName?.toLowerCase().includes(normalized) ?? false),
          )
        : group.models,
    }))
    .filter((group) => group.models.length > 0)
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery('')
        onOpenChange(next)
      }}
      ariaLabel="Select model"
      popupRole="menu"
      placement="top-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          {...triggerProps}
        >
          <ChatGlyph className="icon-sm text-[color:var(--text-muted)]" />
          <TruncatedText as="span" text={label} className="max-w-[200px]" />
          <ChevronGlyph className="icon-xs text-[color:var(--text-disabled)]" />
        </button>
      )}
    >
      <div className="flex max-h-[360px] w-[280px] flex-col overflow-hidden">
        {totalModels > 8 ? (
          <div className="border-b border-[color:var(--border-subtle)] p-1">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="w-full bg-transparent px-2 py-1 text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] focus:outline-none"
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {totalModels === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-[color:var(--text-muted)]" role="status">
              No models available
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-[color:var(--text-muted)]" role="status">
              No models match “{query.trim()}”
            </div>
          ) : (
            filtered.map((group) => (
              <div key={group.providerId} className="py-0.5">
                {groups.length > 1 ? (
                  <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-[color:var(--text-muted)]">
                    {group.providerLabel}
                  </div>
                ) : null}
                {group.models.map((model) => {
                  const isCurrent = group.providerId === selectedProviderId && model.id === selectedModelId
                  return (
                    <button
                      key={`${group.providerId}:${model.id}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      onClick={() => onSelect(group.providerId, model.id)}
                      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                        isCurrent
                          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <TruncatedText as="span" text={model.displayName ?? model.id} className="min-w-0 flex-1" />
                      {isCurrent ? <span className="text-[color:var(--accent-primary)]">✓</span> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </Popover>
  )
}

// Circular composer action: accent-filled send, or a neutral stop while a turn
// streams. Flat fill only — no gradient/shadow — per the app-shell button rules.
function ComposerActionButton({
  tone,
  ariaLabel,
  onClick,
  disabled,
  children,
}: {
  tone: 'accent' | 'neutral'
  ariaLabel: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'accent'
      ? 'bg-[color:var(--accent-primary)] text-[color:var(--bg-app)] hover:bg-[color:var(--accent-primary-hover)] disabled:hover:bg-[color:var(--accent-primary)]'
      : 'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] disabled:hover:bg-[color:var(--bg-surface)]'
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${toneClass}`}
    >
      {children}
    </button>
  )
}

function SendArrowGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 15.5V5M10 5L5.75 9.25M10 5l4.25 4.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.6" fill="currentColor" />
    </svg>
  )
}

function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 5.75h14a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H10l-3.75 3v-3H5A1.75 1.75 0 0 1 3.25 15.5v-8A1.75 1.75 0 0 1 5 5.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const NOTICE_TONE: Record<'neutral' | 'warn' | 'error', { border: string; text: string }> = {
  neutral: { border: 'border-[color:var(--border-strong)]', text: 'text-[color:var(--text-muted)]' },
  warn: { border: 'border-[color:var(--tone-warn)]', text: 'text-[color:var(--tone-warn)]' },
  error: { border: 'border-[color:var(--tone-error)]', text: 'text-[color:var(--tone-error)]' },
}

function ChatNotice({ tone, children }: { tone: 'neutral' | 'warn' | 'error'; children: React.ReactNode }) {
  const style = NOTICE_TONE[tone]
  return <div className={`mx-3 my-2 border-l-2 pl-3 text-[12px] leading-5 ${style.border} ${style.text}`}>{children}</div>
}

function ConversationPendingDock({
  entries,
  onApprove,
  busy,
}: {
  entries: TranscriptEntry[]
  onApprove: (requestId: string, approved: boolean) => void
  busy: boolean
}) {
  const pendingApproval = [...entries].reverse().find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval' && entry.status === 'pending',
  )
  if (pendingApproval) {
    return (
      <div className="mb-2 rounded-lg border border-[color:var(--tone-warn-soft)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--tone-warn)]">
              <StatusDot tone="warn" pulse label="Question pending" />
              Question from agent
            </span>
            <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)]">{pendingApproval.summary}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <PrimaryButton size="sm" onClick={() => onApprove(pendingApproval.requestId, true)} disabled={busy}>
              Approve
            </PrimaryButton>
            <GhostButton
              size="sm"
              onClick={() => onApprove(pendingApproval.requestId, false)}
              disabled={busy}
              className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
            >
              Deny
            </GhostButton>
          </div>
        </div>
      </div>
    )
  }

  return null
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
      <span className="thinking-dot-wave h-1 w-1 rounded-full bg-[color:var(--accent-primary)]" />
      <span className="thinking-dot-wave h-1 w-1 rounded-full bg-[color:var(--accent-primary)] [animation-delay:120ms]" />
      <span className="thinking-dot-wave h-1 w-1 rounded-full bg-[color:var(--accent-primary)] [animation-delay:240ms]" />
    </span>
  )
}

function TimelineRow({ row }: { row: ConversationTimelineRow }) {
  return (
    <div className="conversation-row-enter" data-conversation-row-kind={row.kind}>
      {row.kind === 'user' ? <UserTimelineRow entry={row.entry} /> : null}
      {row.kind === 'assistant' ? <AssistantTimelineRow entry={row.entry} /> : null}
      {row.kind === 'activity' ? <ActivityTimelineRow row={row} /> : null}
      {row.kind === 'approval' ? <ApprovalHistoryRow entry={row.entry} /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
}

function UserTimelineRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-[color:var(--bg-hover)] px-3 py-2">
        <p className="whitespace-pre-wrap text-sm text-[color:var(--text-strong)]">{entry.text}</p>
      </div>
    </div>
  )
}

function AssistantTimelineRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'assistant' }> }) {
  return (
    <div className="group/assistant flex flex-col gap-1 px-1 py-0.5">
      {entry.text ? renderMarkdown(entry.text) : null}
      <AssistantStatusMeta entry={entry} />
    </div>
  )
}

function AssistantStatusMeta({ entry }: { entry: Extract<TranscriptEntry, { kind: 'assistant' }> }) {
  if (entry.status === 'complete' && entry.completedAt && entry.startedAt) {
    return (
      <span className="text-[11px] text-[color:var(--text-subtle)]">
        Completed in {formatElapsedMs(entry.completedAt - entry.startedAt)}
      </span>
    )
  }
  if (entry.status === 'failed' || entry.status === 'interrupted') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-subtle)]">
        {entry.status === 'failed' ? <StatusDot tone="error" label="Failed" /> : null}
        {entry.status === 'interrupted'
          ? 'Interrupted'
          : `Failed${entry.failureReason ? ` · ${entry.failureReason}` : ''}`}
      </span>
    )
  }
  return null
}

function ActivityTimelineRow({ row }: { row: Extract<ConversationTimelineRow, { kind: 'activity' }> }) {
  const [showAll, setShowAll] = useState(false)
  const visibleTools = showAll ? row.tools : row.tools.slice(0, MAX_VISIBLE_TOOL_ROWS)
  const hiddenCount = row.tools.length - visibleTools.length
  if (!row.reasoning.trim() && row.tools.length === 0) return null
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          {row.reasoningStatus === 'streaming' ? <ThinkingDots /> : null}
          {row.reasoning.trim() && row.tools.length > 0
            ? 'Thinking and tool calls'
            : row.reasoning.trim()
              ? 'Thinking'
              : `Tool calls (${row.tools.length})`}
        </span>
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="shrink-0 text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
          >
            Show {hiddenCount} more
          </button>
        ) : showAll && row.tools.length > MAX_VISIBLE_TOOL_ROWS ? (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="shrink-0 text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
          >
            Show less
          </button>
        ) : null}
      </div>
      {row.reasoning.trim() ? <ReasoningBlock text={row.reasoning} status={row.reasoningStatus} /> : null}
      {visibleTools.length > 0 ? (
        <div className="mt-1 space-y-1">
          {visibleTools.map((tool) => <ToolCallRow key={tool.id} tool={tool} />)}
        </div>
      ) : null}
    </div>
  )
}

function ReasoningBlock({
  text,
  status,
}: {
  text: string
  status: Extract<TranscriptEntry, { kind: 'assistant' }>['status']
}) {
  const [expanded, setExpanded] = useState(status === 'streaming')
  const canCollapse = status !== 'streaming' && (text.length > 280 || text.split('\n').length > 4)
  const visible = canCollapse && !expanded ? `${text.slice(0, 280).trimEnd()}...` : text
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          {status === 'streaming' ? <ThinkingDots /> : null}
          Reasoning
        </span>
        {canCollapse ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
          >
            {expanded ? 'Show less' : 'Show reasoning'}
          </button>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-[color:var(--text-default)]">{visible}</p>
    </div>
  )
}

function ToolCallRow({ tool }: { tool: Extract<TranscriptEntry, { kind: 'tool' }> }) {
  const [outputExpanded, setOutputExpanded] = useState(false)
  const hasOutput = Boolean(tool.output?.trim())
  const output = tool.output ?? ''
  const shouldCollapseOutput = output.length > 320 || output.split('\n').length > 6
  const visibleOutput = shouldCollapseOutput && !outputExpanded ? `${output.slice(0, 320).trimEnd()}...` : output
  const running = tool.status === 'running'
  return (
    <div className={`rounded-md border px-2.5 py-2 ${
      running
        ? 'border-[color:var(--accent-primary-soft-strong)] bg-[color:var(--accent-primary-soft)]'
        : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]'
    }`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] ${running ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-muted)]'}`}>
          {running ? <StatusDot tone="accent" pulse label="Running" /> : null}
          <ToolGlyph className="icon-xs" />
          <span>Tool call</span>
          <span aria-hidden="true">·</span>
          <TruncatedText as="span" text={tool.name} className="font-mono text-[color:var(--text-default)]" />
        </span>
        <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">{running ? 'running' : 'done'}</span>
      </div>
      {hasOutput ? (
        <div className="mt-1">
          {shouldCollapseOutput ? (
            <button
              type="button"
              onClick={() => setOutputExpanded((value) => !value)}
              className="mb-1 text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
            >
              {outputExpanded ? 'Hide output' : 'Show output'}
            </button>
          ) : null}
          {(outputExpanded || !shouldCollapseOutput) ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-[color:var(--text-default)]">{visibleOutput}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ApprovalHistoryRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'approval' }> }) {
  const approvalNeedsDot = entry.status === 'denied'
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
        {approvalNeedsDot ? <StatusDot tone={APPROVAL_TONE[entry.status]} label={APPROVAL_LABEL[entry.status]} /> : null}
        {APPROVAL_LABEL[entry.status]}
      </span>
      <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)]">{entry.summary}</p>
    </div>
  )
}

function WorkingTimelineRow({ row }: { row: Extract<ConversationTimelineRow, { kind: 'working' }> }) {
  return (
    <div className="pl-1.5">
      <div className="inline-flex items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
        <ThinkingDots />
        <span>{row.label}</span>
        {row.startedAt ? (
          <>
            <span aria-hidden="true">·</span>
            <LiveElapsed startedAt={row.startedAt} />
          </>
        ) : null}
      </div>
    </div>
  )
}

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const initial = formatElapsedMs(Date.now() - startedAt)
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatElapsedMs(Date.now() - startedAt)
    }
    update()
    const id = window.setInterval(update, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])
  return <span ref={textRef}>{initial}</span>
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function ToolGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M7.2 13.2 4.8 15.6a1.8 1.8 0 0 1-2.5-2.5l2.4-2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m12.8 6.8 2.4-2.4a1.8 1.8 0 0 1 2.5 2.5l-2.4 2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M6.8 6.8h6.4v6.4H6.8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}
