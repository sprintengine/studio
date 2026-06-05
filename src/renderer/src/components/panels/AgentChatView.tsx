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
import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, PrimaryButton, StatusDot, type Tone } from '../ui'

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
        if (turnId) ensureTurn(turnId).status = 'streaming'
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
        if (turnId) ensureTurn(turnId).status = 'complete'
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

const SESSION_TONE: Record<ConversationSessionStatus | 'idle', Tone> = {
  idle: 'neutral',
  starting: 'accent',
  ready: 'good',
  active: 'accent',
  awaiting_approval: 'warn',
  stopped: 'neutral',
  failed: 'error',
}

const COMPOSER_CLASS =
  'min-h-[40px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45'

type PendingAction = 'starting' | 'sending' | 'stopping' | null

export function stopDisabledForPending(pending: PendingAction): boolean {
  return pending === 'stopping'
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
  const conversation = agent?.conversation
  const label = agent?.name ?? agentId
  const workspaceRoot = workspace?.folderPath ?? null

  const [readiness, setReadiness] = useState<ChatReadiness>({ kind: 'loading' })
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
        const provider = list.providers.find((entry) => entry.id === conversation.providerId)
        if (!provider) {
          setReadiness({ kind: 'provider-unavailable', providerId: conversation.providerId })
          return
        }
        if (!provider.models.some((model) => model.id === conversation.modelId)) {
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

  // Subscribe to canonical events for this agent's session.
  useEffect(() => {
    if (typeof window.api.onConversationEvent !== 'function') return
    const unsubscribe = window.api.onConversationEvent((event) => {
      if (event.workspaceId !== workspaceId || event.agentId !== agentId) return
      setEvents((current) => [...current, event])
    })
    return unsubscribe
  }, [workspaceId, agentId])

  const projection = useMemo(() => projectConversation(events, userTurns), [events, userTurns])

  // Keep the newest message in view without jumping focus.
  useEffect(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [projection.entries.length, projection.activeTurn])

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
      <ChatShell label={label} sessionStatus="idle">
        <ChatNotice tone="error">This agent has no conversation provider selected.</ChatNotice>
      </ChatShell>
    )
  }

  const ready = readiness.kind === 'ready'
  const composerDisabled = !ready || projection.activeTurn || pending !== null
  const sessionStatus = projection.sessionStatus
  const showRetry = projection.lastError !== null && !projection.activeTurn

  return (
    <ChatShell label={label} sessionStatus={sessionStatus} model={conversation.modelId}>
      {!ready ? (
        <ChatNotice tone={readiness.kind === 'loading' ? 'neutral' : 'warn'}>{readinessLabel(readiness)}</ChatNotice>
      ) : null}

      <div
        ref={listRef}
        role="log"
        aria-label={`${label} conversation`}
        aria-live="polite"
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {projection.entries.length === 0 ? (
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            {ready ? 'No messages yet. Send a prompt to start the conversation.' : 'Conversation is unavailable until the provider is ready.'}
          </p>
        ) : (
          projection.entries.map((entry) => (
            <TranscriptRow key={entryKey(entry)} entry={entry} onApprove={resolveApproval} busy={pending !== null} />
          ))
        )}
      </div>

      <div className="border-t border-[color:var(--border-subtle)] px-3 py-2">
        {actionError ? <ChatNotice tone="error">{actionError}</ChatNotice> : null}
        {projection.usage ? (
          <p className="mb-2 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            Tokens — in {projection.usage.inputTokens}, out {projection.usage.outputTokens}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
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
          {projection.activeTurn ? (
            <GhostButton
              size="md"
              onClick={() => void interrupt()}
              disabled={stopDisabledForPending(pending)}
              className="h-10 shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
            >
              {pending === 'stopping' ? 'Stopping…' : 'Stop'}
            </GhostButton>
          ) : showRetry ? (
            <GhostButton
              size="md"
              onClick={retry}
              disabled={composerDisabled}
              className="h-10 shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
            >
              Retry
            </GhostButton>
          ) : (
            <PrimaryButton
              size="md"
              onClick={() => void sendTurn(draft)}
              disabled={composerDisabled || !draft.trim()}
              className="h-10 shrink-0"
            >
              {pending === 'starting' || pending === 'sending' ? 'Sending…' : 'Send'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </ChatShell>
  )
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

function ChatShell({
  label,
  sessionStatus,
  model,
  children,
}: {
  label: string
  sessionStatus: ConversationSessionStatus | 'idle'
  model?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-surface)] text-[12px] text-[color:var(--text-default)]">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">{label}</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          {model ? <span className="font-mono text-[color:var(--text-default)]">{model}</span> : null}
          <StatusDot tone={SESSION_TONE[sessionStatus]} pulse={sessionStatus === 'active'} />
          <span>{formatSessionStatus(sessionStatus)}</span>
        </span>
      </div>
      {children}
    </div>
  )
}

function formatSessionStatus(status: ConversationSessionStatus | 'idle'): string {
  switch (status) {
    case 'idle':
      return 'Not started'
    case 'starting':
      return 'Starting'
    case 'ready':
      return 'Ready'
    case 'active':
      return 'Responding'
    case 'awaiting_approval':
      return 'Awaiting approval'
    case 'stopped':
      return 'Stopped'
    case 'failed':
      return 'Failed'
  }
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

function TranscriptRow({
  entry,
  onApprove,
  busy,
}: {
  entry: TranscriptEntry
  onApprove: (requestId: string, approved: boolean) => void
  busy: boolean
}) {
  if (entry.kind === 'user') {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] text-[color:var(--text-subtle)]">You</span>
        <p className="whitespace-pre-wrap text-sm text-[color:var(--text-strong)]">{entry.text}</p>
      </div>
    )
  }

  if (entry.kind === 'assistant') {
    const statusTone: Tone =
      entry.status === 'failed' ? 'error' : entry.status === 'interrupted' ? 'warn' : entry.status === 'complete' ? 'good' : 'accent'
    return (
      <div className="flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-subtle)]">
          <StatusDot tone={statusTone} pulse={entry.status === 'streaming'} />
          Assistant
          {entry.status === 'streaming' ? ' · responding' : null}
          {entry.status === 'interrupted' ? ' · interrupted' : null}
          {entry.status === 'failed' ? ` · failed${entry.failureReason ? ` (${entry.failureReason})` : ''}` : null}
        </span>
        {entry.text ? (
          <p className="whitespace-pre-wrap text-sm text-[color:var(--text-default)]">{entry.text}</p>
        ) : entry.status === 'streaming' ? (
          <p className="text-sm text-[color:var(--text-muted)]">…</p>
        ) : null}
      </div>
    )
  }

  if (entry.kind === 'tool') {
    return (
      <div className="rounded-md border border-[color:var(--border-subtle)] px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          <StatusDot tone={entry.status === 'done' ? 'good' : 'accent'} pulse={entry.status === 'running'} />
          Tool · <span className="font-mono text-[color:var(--text-default)]">{entry.name}</span>
          {entry.status === 'running' ? ' · running' : ' · done'}
        </span>
        {entry.output ? (
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-[color:var(--text-default)]">{entry.output}</pre>
        ) : null}
      </div>
    )
  }

  // approval
  return (
    <div className="rounded-md border border-[color:var(--border-default)] px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
        <StatusDot tone={APPROVAL_TONE[entry.status]} />
        {APPROVAL_LABEL[entry.status]}
      </span>
      <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)]">{entry.summary}</p>
      {entry.status === 'pending' ? (
        <div className="mt-2 flex gap-2">
          <PrimaryButton size="sm" onClick={() => onApprove(entry.requestId, true)} disabled={busy}>
            Approve
          </PrimaryButton>
          <GhostButton
            size="sm"
            onClick={() => onApprove(entry.requestId, false)}
            disabled={busy}
            className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
          >
            Deny
          </GhostButton>
        </div>
      ) : null}
    </div>
  )
}
