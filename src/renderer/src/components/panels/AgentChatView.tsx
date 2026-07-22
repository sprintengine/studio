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
  ConversationApprovalKind,
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationQuestion,
  ConversationSessionStatus,
} from '../../../../shared/conversation-runtime'
import type { ConversationProviderListEntry, ConversationProviderModel } from '../../../../shared/plugin-manifest'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { uniqueAgentName } from '../workspace/workspaceManagerHelpers'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { renderMarkdown } from '../../utils/markdown'
import { FilterMenu, GhostButton, InlineSkillPicker, Popover, PrimaryButton, SkillPickerPopover, StatusDot, Tooltip, TruncatedText } from '../ui'
import type { InlineSkillPickerHandle } from '../ui'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import { renderChatSkillPrefill } from '../../utils/skillInvocation'
import { CreationBackdrop } from '../backdrops/CreationBackdrop'

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
  | {
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
    }
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

export type UserTurn = { id: string; text: string }

export type ConversationProjection = {
  sessionStatus: ConversationSessionStatus | 'idle'
  activeTurn: boolean
  awaitingApproval: boolean
  entries: TranscriptEntry[]
  usage: { inputTokens: number; outputTokens: number } | null
  lastError: string | null
  // Credential source the CLI child reported on init ('none' = subscription
  // login, the guaranteed path). Anything else means the session is billing
  // outside the subscription and the chat must say so.
  apiKeySource: string | null
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

function readApprovalKind(payload: Record<string, unknown> | undefined): ConversationApprovalKind {
  const value = payload?.kind
  return value === 'question' || value === 'plan' ? value : 'tool'
}

function readQuestions(payload: Record<string, unknown> | undefined): ConversationQuestion[] | undefined {
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

function readAnswers(payload: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const raw = payload?.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') answers[key] = value
  }
  return Object.keys(answers).length > 0 ? answers : undefined
}

type TurnAccumulator = {
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
  tools: Map<
    string,
    {
      id: string
      name: string
      status: 'running' | 'done'
      output?: string
      summary?: string
      startedAt?: number
      completedAt?: number
      addedLines?: number
      removedLines?: number
    }
  >
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
  // User bubbles recorded in the event stream itself (persisted transcript);
  // when present these are authoritative and the locally tracked userTurns
  // only fill the optimistic gap between a send and its first event.
  const eventUserTurns = new Map<string, { id: string; text: string }>()
  const representedLocalTurnIds = new Set<string>()
  const approvals = new Map<string, Omit<Extract<TranscriptEntry, { kind: 'approval' }>, 'kind'>>()
  const approvalOrder: string[] = []
  let sessionStatus: ConversationSessionStatus | 'idle' = 'idle'
  let usage: { inputTokens: number; outputTokens: number } | null = null
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
          eventUserTurns.set(turnId, { id: event.id, text: readString(event.payload, 'text') ?? '' })
          const localTurnId = readString(event.payload, 'localTurnId')
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
        turn.tools.set(id, {
          id,
          name: readString(event.payload, 'name', 'toolName', 'tool') ?? 'tool',
          status: 'running',
          summary: readString(event.payload, 'summary'),
          startedAt: event.createdAt,
          addedLines: readNumber(event.payload, 'addedLines'),
          removedLines: readNumber(event.payload, 'removedLines'),
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
          plan: requestKind === 'plan' ? readString(event.payload, 'plan') ?? '' : undefined,
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
  const useEventUserTurns = eventUserTurns.size > 0
  const blockCount = useEventUserTurns ? turnOrder.length : Math.max(turnOrder.length, userTurns.length)
  for (let i = 0; i < blockCount; i += 1) {
    const turnId = turnOrder[i]
    const eventUserTurn = turnId ? eventUserTurns.get(turnId) : undefined
    if (useEventUserTurns) {
      if (eventUserTurn) entries.push({ kind: 'user', id: eventUserTurn.id, text: eventUserTurn.text })
    } else {
      const userTurn = userTurns[i]
      if (userTurn) entries.push({ kind: 'user', id: userTurn.id, text: userTurn.text })
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
    for (const tool of turn.tools.values()) {
      entries.push({
        kind: 'tool',
        id: tool.id,
        turnId: turn.turnId,
        name: tool.name,
        status: tool.status,
        output: tool.output,
        summary: tool.summary,
        startedAt: tool.startedAt,
        completedAt: tool.completedAt,
        addedLines: tool.addedLines,
        removedLines: tool.removedLines,
      })
    }
    for (const requestId of turn.approvals) {
      const approval = approvals.get(requestId)
      if (approval) entries.push({ kind: 'approval', ...approval })
    }
  }
  // Optimistic tail: local sends not yet represented by user_message events.
  if (useEventUserTurns) {
    for (const userTurn of userTurns) {
      if (!representedLocalTurnIds.has(userTurn.id)) {
        entries.push({ kind: 'user', id: userTurn.id, text: userTurn.text })
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
  // One row per assistant turn: byline, reasoning disclosure, work timeline
  // (the turn's tools) and prose all render as a single block, per the
  // approved MC-1478 mockup.
  | {
      kind: 'assistant'
      id: string
      entry: Extract<TranscriptEntry, { kind: 'assistant' }>
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

// ── Presentation vocabulary (pure, unit-tested) ─────────────────────────────

// Step verbs: past tense for finished steps, continuous for the live one.
const TOOL_VERBS: Record<string, { done: string; live: string }> = {
  Read: { done: 'Read', live: 'Reading' },
  Grep: { done: 'Searched', live: 'Searching' },
  Glob: { done: 'Searched', live: 'Searching' },
  WebSearch: { done: 'Searched', live: 'Searching' },
  Edit: { done: 'Edited', live: 'Editing' },
  MultiEdit: { done: 'Edited', live: 'Editing' },
  NotebookEdit: { done: 'Edited', live: 'Editing' },
  Write: { done: 'Wrote', live: 'Writing' },
  Bash: { done: 'Ran', live: 'Running' },
  WebFetch: { done: 'Fetched', live: 'Fetching' },
}

export function toolVerb(tool: string, live: boolean): string {
  const verbs = TOOL_VERBS[tool]
  if (verbs) return live ? verbs.live : verbs.done
  return live ? `Calling ${tool}` : `Called ${tool}`
}

// The step object is the provider summary minus its "Tool: " prefix — the verb
// already says which tool ran.
export function toolObject(tool: { name: string; summary?: string }): string {
  const summary = tool.summary ?? ''
  const prefix = `${tool.name}: `
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary
}

// The CLI convention marks a suggested answer with a "(Recommended)" suffix in
// the option label; render it as a quiet accent label instead of literal text.
// Answers are still submitted with the original label so the tool round-trips.
export function parseOptionLabel(label: string): { text: string; recommended: boolean } {
  const match = label.match(/^(.*?)\s*\(recommended\)\s*$/i)
  return match?.[1] ? { text: match[1], recommended: true } : { text: label, recommended: false }
}

export function formatStepDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

// Auth-shaped turn failures get a `claude login` hint in the error block.
export function isAuthShapedFailure(reason: string | undefined): boolean {
  return Boolean(reason && /auth|login|oauth|credential|401|expired|api key/i.test(reason))
}

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
      if (
        entry.text.trim()
        || entry.reasoning.trim()
        || tools.length > 0
        || entry.status === 'failed'
        || entry.status === 'interrupted'
      ) {
        rows.push({ kind: 'assistant', id: `assistant:${entry.turnId}`, entry, tools })
      }
      index = cursor - 1
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
        ? `${toolVerb(runningTool.name, true)}${toolObject(runningTool) ? ` ${toolObject(runningTool)}` : ''}…`
        : stage === 'responding'
          ? 'Replying…'
          : 'Thinking…'
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

// Stable empty-catalog reference: returned for any provider whose live catalog
// has not loaded so effects keyed on the derived list do not re-run each render.
const EMPTY_MODELS: ConversationProviderModel[] = []

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

// Whether the session can accept a live send right now. The runtime rejects a
// new turn while `pendingRequestId` is set — which spans the whole active turn,
// not just the awaiting-approval window (conversation-runtime.ts:200). So a
// submit made while busy is queued and auto-sent on unlock (D6/1776) rather than
// fired as a live IPC that would error. Type-ahead into the textarea is always
// allowed; only the send/queue routing keys off this.
export function isConversationBusy(
  activeTurn: boolean,
  awaitingApproval: boolean,
  pending: PendingAction,
): boolean {
  return activeTurn || awaitingApproval || pending !== null
}

// The model is editable only until the conversation starts: the runtime binds a
// session to one provider/model, so once the user has sent a turn (or a session
// exists) the in-composer picker locks. A replayed transcript counts as a
// started conversation too — after an app restart userTurns/sessionId are empty
// local state, but switching models over restored history would silently start
// a fresh session mid-thread.
export function isConversationModelLocked(
  userTurnCount: number,
  sessionId: string | null,
  hasTranscriptHistory = false,
): boolean {
  return userTurnCount > 0 || sessionId !== null || hasTranscriptHistory
}

// Chrome the timeline rows need from the component: who is speaking, how to
// name models, and where Retry routes.
type TimelineChrome = {
  assistantName: string
  modelLabelFor: (modelId?: string) => string
  // Only the latest failed turn is retryable (retry re-sends the last message).
  retryTurnId?: string
  onRetry: () => void
  retryDisabled: boolean
}

export default function AgentChatView({ workspaceId, agentId }: Props) {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const conversation = agent?.conversation
  const label = agent?.name ?? agentId
  const workspaceRoot = workspace?.folderPath ?? null

  const [readiness, setReadiness] = useState<ChatReadiness>({ kind: 'loading' })
  const [providers, setProviders] = useState<ConversationProviderListEntry[]>([])
  // Live model catalogs keyed by providerId, fetched lazily as the user opens
  // the picker or filters to a provider — never a blanket prefetch. A non-empty
  // entry is preferred over the manifest seed.
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ConversationProviderModel[]>>({})
  // Whether each provider has a configured key, fetched alongside its catalog.
  // Drives the explicit "add key" vs "no models" group state so a key-configured
  // provider never collapses into a silent stale seed.
  const [keyByProvider, setKeyByProvider] = useState<Record<string, boolean>>({})
  // The active provider's live catalog (stable ref per cache entry) feeds the
  // current-model label, context length, and the tab self-heal below.
  const liveModels = catalogByProvider[conversation?.providerId ?? ''] ?? EMPTY_MODELS
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [userTurns, setUserTurns] = useState<UserTurn[]>([])
  // Skill-at-spawn seeds the first draft (prefill only — the user submits).
  const [draft, setDraft] = useState(() => agent?.chatComposerPrefill ?? '')
  const [pending, setPending] = useState<PendingAction>(null)
  // Type-ahead queue (D6/1776): a message the user committed while the session
  // was busy. It holds until the turn unlocks, then auto-sends as a follow-up
  // turn. Null when nothing is queued; a second commit while busy appends so no
  // typed intent is dropped.
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false)
  // Slash trigger: Escape or non-matching text sets dismissed so the slash
  // stays literal; cleared once the draft no longer starts with '/'.
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashPickerRef = useRef<InlineSkillPickerHandle | null>(null)
  const openConnectorsSurface = useWorkspaceStore((s) => s.openConnectorsSurface)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const listRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // Completed assistant replies the user has "seen" (was at the bottom for);
  // the jump pill counts completions past this baseline while scrolled up.
  const repliesSeenRef = useRef(0)

  // The prefill is one-shot: once the user has sent anything, clear it from the
  // record so a later remount never re-seeds a stale invocation.
  useEffect(() => {
    if (!agent?.chatComposerPrefill || userTurns.length === 0) return
    updateAgent(workspaceId, agentId, { chatComposerPrefill: undefined })
  }, [agent?.chatComposerPrefill, userTurns.length, updateAgent, workspaceId, agentId])

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
        const list = await window.api.conversationProvidersList({
          cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
        })
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
        // Listed but unable to start sessions (e.g. its CLI was not found):
        // surface the provider's own plain-language reason.
        if (provider.unavailable) {
          setReadiness({ kind: 'error', message: provider.unavailable })
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
  }, [conversation, workspaceRoot, cliRuntimes])

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

  // Replay the persisted transcript once per mount so the conversation
  // survives app/tab reloads. Replayed events are older than anything the live
  // subscription delivers, so they are prepended; ids dedupe the overlap.
  useEffect(() => {
    if (!workspaceRoot || typeof window.api.conversationTranscript !== 'function') return
    let cancelled = false
    void window.api
      .conversationTranscript({ workspaceRoot, workspaceId, agentId })
      .then((result) => {
        if (cancelled || !result.ok || result.events.length === 0) return
        const replayed = result.events.filter((event) => !seenEventIdsRef.current.has(event.id))
        if (replayed.length === 0) return
        for (const event of replayed) seenEventIdsRef.current.add(event.id)
        setEvents((current) => [...replayed, ...current])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, workspaceId, agentId])

  // Fetch one provider's live catalog and key status on demand, caching both.
  // Called for the active provider on mount and for whichever provider the user
  // filters to in the picker — never a blanket fan-out over every provider.
  // Failures are silent: the picker falls back to the manifest seed (unknown key
  // state) or its explicit empty state (known key state), never a stale list.
  const fetchProviderCatalog = useCallback((providerId: string) => {
    if (!providerId) return
    if (typeof window.api.conversationProviderModels === 'function') {
      void window.api
        .conversationProviderModels({ providerId })
        .then((result) => {
          if (result.ok) setCatalogByProvider((current) => ({ ...current, [providerId]: result.models }))
        })
        .catch(() => undefined)
    }
    if (typeof window.api.conversationSecretStatus === 'function') {
      void window.api
        .conversationSecretStatus({ providerId })
        .then((result) => {
          if (result.ok) setKeyByProvider((current) => ({ ...current, [providerId]: result.status.configured }))
        })
        .catch(() => undefined)
    }
  }, [])

  // Fetch the active provider up front so the current model's display label,
  // context length, and readiness resolve before the picker is ever opened.
  useEffect(() => {
    const providerId = conversation?.providerId
    if (providerId) fetchProviderCatalog(providerId)
  }, [conversation?.providerId, fetchProviderCatalog])

  const projection = useMemo(() => projectConversation(events, userTurns), [events, userTurns])
  const timelineRows = useMemo(
    () => deriveConversationTimelineRows(projection.entries, projection.activeTurn),
    [projection.entries, projection.activeTurn],
  )

  // Follow the stream only while the user is at (or near) the bottom: reading
  // scrollback must never be yanked away by incoming tokens. A "jump to
  // latest" pill appears once they scroll up. Keyed on events.length so token
  // appends (which don't change the row count) also keep the view pinned.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const handleLogScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48
    atBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])
  const jumpToLatest = useCallback(() => {
    const node = listRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }, [])
  useEffect(() => {
    const node = listRef.current
    if (node && atBottomRef.current) node.scrollTop = node.scrollHeight
  }, [events.length, timelineRows.length, projection.activeTurn])

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
      cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
    })
    if (!result.ok) {
      setActionError(result.message)
      return null
    }
    setSessionId(result.session.sessionId)
    return result.session.sessionId
  }, [agentId, cliRuntimes, conversation, sessionId, workspaceId, workspaceRoot])

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
      const localTurnId = `user-${userTurns.length}-${Date.now()}`
      setUserTurns((current) => [...current, { id: localTurnId, text }])
      setDraft('')
      setPending('sending')
      try {
        const result = await window.api.conversationSessionSendTurn({
          sessionId: activeSession,
          message: text,
          localTurnId,
        })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not send the message.')
      } finally {
        setPending(null)
      }
    },
    [ensureSession, pending, userTurns.length]
  )

  // Composer submit (Enter or the send affordance). Sends immediately when the
  // session is idle; queues the message when a turn is streaming or awaiting
  // approval, so the user gets terminal-style type-ahead without the send
  // erroring against the runtime's turn guard (D6/1776). The flush effect below
  // sends the queued message the moment the session unlocks.
  const submitComposer = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)) {
      setQueuedMessage((prev) => (prev ? `${prev}\n${text}` : text))
      setDraft('')
      return
    }
    void sendTurn(text)
  }, [draft, projection.activeTurn, projection.awaitingApproval, pending, sendTurn])

  // Auto-send the queued message as a follow-up turn once the session idles.
  // Gated on the same busy signal the submit uses, so it never races the guard;
  // sendTurn's own `pending` guard prevents a re-entrant double send.
  useEffect(() => {
    if (queuedMessage === null || readiness.kind !== 'ready') return
    if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)) return
    const text = queuedMessage
    setQueuedMessage(null)
    void sendTurn(text)
  }, [queuedMessage, readiness.kind, projection.activeTurn, projection.awaitingApproval, pending, sendTurn])

  // Approval/question cards resolve mid-turn on stateful providers — while the
  // sendTurn promise is still pending — so they get their own busy latch
  // instead of the composer's `pending` (which would deadlock the card: the
  // turn cannot finish until the card is answered).
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const resolveApproval = useCallback(
    async (requestId: string, approved: boolean, answers?: Record<string, string>) => {
      if (!sessionId || respondingRequestId) return
      setActionError(null)
      setRespondingRequestId(requestId)
      try {
        const result = await window.api.conversationSessionRespondToRequest({ sessionId, requestId, approved, answers })
        if (!result.ok) setActionError(result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not record the approval.')
      } finally {
        setRespondingRequestId(null)
      }
    },
    [sessionId, respondingRequestId]
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

  // Retry re-sends the last user message. The projection's entries are the
  // authoritative source — after an app restart the message only exists in the
  // replayed transcript, not in the local userTurns state.
  const retry = useCallback(() => {
    const lastUser = [...projection.entries]
      .reverse()
      .find((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user')
    if (lastUser?.text) void sendTurn(lastUser.text)
  }, [sendTurn, projection.entries])

  if (!conversation) {
    return (
      <ChatShell>
        <ChatNotice tone="error">This agent has no conversation provider selected.</ChatNotice>
      </ChatShell>
    )
  }

  const ready = readiness.kind === 'ready'
  // The session cannot take a live turn right now (streaming, awaiting approval,
  // or an in-flight send). A submit made while busy queues instead of erroring.
  const composerBusy = isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)
  // Retry and other "act now" affordances stay disabled while busy or not ready.
  const composerDisabled = !ready || composerBusy
  // The textarea itself is only disabled before the provider is ready — it stays
  // editable through a stream so type-ahead works (D6/1776).
  const composerInputDisabled = !ready

  // The runtime binds a session to one provider/model, so the model is editable
  // only until the conversation starts: once a turn is sent, a session exists,
  // or replayed history is present, the pill is read-only and the user opens a
  // new agent to change model.
  const modelLocked = isConversationModelLocked(
    userTurns.length,
    sessionId,
    projection.entries.some((entry) => entry.kind === 'user' || entry.kind === 'assistant'),
  )
  // Picker groups: one per provider, merging each provider's own live catalog
  // (fetched when the user browses to it) over its manifest seed. Subscription
  // providers ('agent-harness') sort first and carry the subscription annotation
  // so metered API entries are never mistaken for the user's own plan. A
  // dynamic-catalog provider is never dropped for an empty seed: when its key is
  // missing it shows an explicit add-key state, and when the key is present but
  // the catalog is empty it says so — never a silent stale seed.
  const modelGroups: ModelGroup[] = [...providers]
    .sort((a, b) => Number(b.providerType === 'agent-harness') - Number(a.providerType === 'agent-harness'))
    .map((entry): ModelGroup => {
      const base = { providerId: entry.id, providerLabel: entry.displayName, unavailable: entry.unavailable }
      const liveCatalog = catalogByProvider[entry.id]
      const hasLive = Array.isArray(liveCatalog) && liveCatalog.length > 0
      // Subscription (agent-harness) providers need no key: live catalog if it
      // loaded, else the seed. Static model-providers list their full seed as-is
      // — it is the complete catalog, not a truncated one.
      if (entry.providerType === 'agent-harness' || !entry.supportsDynamicModels) {
        return {
          ...base,
          subscription: entry.providerType === 'agent-harness',
          models: hasLive ? liveCatalog : entry.models,
        }
      }
      // Dynamic model-providers (OpenRouter, xAI): key state gates the catalog.
      const hasKey = keyByProvider[entry.id]
      if (hasKey === false) return { ...base, models: [], emptyState: 'add-key' }
      if (hasLive) return { ...base, models: liveCatalog }
      // Key present but catalog empty/unreachable: say so rather than seed.
      if (hasKey === true) return { ...base, models: [], emptyState: 'no-models' }
      // Key state not yet fetched — show the seed provisionally until the user
      // browses to this provider and its live catalog + key status load.
      return { ...base, models: entry.models }
    })
  const currentModel = modelGroups
    .find((group) => group.providerId === conversation.providerId)
    ?.models.find((model) => model.id === conversation.modelId)
  const currentModelLabel = currentModel?.displayName ?? conversation.modelId
  const contextLength = currentModel?.contextLength
  const usedTokens = projection.usage ? projection.usage.inputTokens + projection.usage.outputTokens : 0
  const selectModel = (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    if (modelLocked || (providerId === conversation.providerId && modelId === conversation.modelId)) return
    const nextLabel = modelGroups
      .find((group) => group.providerId === providerId)
      ?.models.find((model) => model.id === modelId)?.displayName
    // The tab was named after the spawn-default model; once the user picks a
    // different model before the conversation starts, keep the tab truthful.
    // Only auto-created names are touched — a user-renamed tab (no model-label
    // match, ignoring a uniqueness suffix) stays as the user wrote it — and
    // the new name is re-uniqued against the workspace's other agents so two
    // tabs never end up with the same label.
    const baseName = (agent?.name ?? '').replace(/ \d+$/, '')
    const renaming = Boolean(nextLabel && (baseName === currentModelLabel || agent?.name === conversation.modelId))
    updateAgent(workspaceId, agentId, {
      conversation: { providerId, modelId },
      ...(renaming && nextLabel && workspace
        ? {
            name: uniqueAgentName(
              nextLabel,
              Object.fromEntries(Object.entries(workspace.agents).filter(([id]) => id !== agentId)),
            ),
          }
        : {}),
    })
    setLastSelectedConversationModel({ providerId, modelId })
  }

  // Agent-harness providers (the Claude CLI) run tools and speak as "Claude";
  // plain model providers are a direct chat with the model.
  const providerEntry = providers.find((entry) => entry.id === conversation.providerId)
  const isAgentHarness = providerEntry?.providerType === 'agent-harness'
  const assistantName = isAgentHarness ? 'Claude' : currentModelLabel

  // Skills doors (agent harness only — plain model chats run no tools):
  // a '/' opening an otherwise-empty draft filters the same inventory the
  // Skills chip shows. A space commits the text as literal (no skill picked).
  const slashPickerActive =
    isAgentHarness && !slashDismissed && draft.startsWith('/') && !/\s/.test(draft)
  const applySkillPick = (skill: WorkspaceSkill) => {
    setDraft(renderChatSkillPrefill(skill))
    setSlashDismissed(true)
    composerRef.current?.focus()
  }
  const modelLabelFor = (modelId?: string): string => {
    if (!modelId) return currentModelLabel
    for (const group of modelGroups) {
      const model = group.models.find((entry) => entry.id === modelId)
      if (model?.displayName) return model.displayName
    }
    return modelId
  }

  const pendingApprovalEntry = [...projection.entries]
    .reverse()
    .find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> =>
        entry.kind === 'approval' && entry.status === 'pending',
    )
  const composerPlaceholder = pendingApprovalEntry
    ? pendingApprovalEntry.requestKind === 'question'
      ? 'Answer the question above to continue'
      : pendingApprovalEntry.requestKind === 'plan'
        ? 'Respond to the plan above to continue'
        : 'Respond to the request above to continue'
    : !ready
      ? readinessLabel(readiness)
      : projection.activeTurn
        ? 'Reply — sends when the turn finishes'
        : 'Send a message…'

  // Retry lives on the failed turn's error block in the transcript; only the
  // latest failed turn is retryable (retry re-sends the last user message).
  const lastFailedTurnId =
    !projection.activeTurn && ready
      ? [...projection.entries]
          .reverse()
          .find(
            (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> =>
              entry.kind === 'assistant' && entry.status === 'failed',
          )?.turnId
      : undefined

  const chrome: TimelineChrome = {
    assistantName,
    modelLabelFor,
    retryTurnId: lastFailedTurnId,
    onRetry: retry,
    retryDisabled: composerDisabled,
  }

  const completedReplies = projection.entries.filter(
    (entry) => entry.kind === 'assistant' && entry.status === 'complete',
  ).length
  if (atBottom && repliesSeenRef.current !== completedReplies) repliesSeenRef.current = completedReplies
  const newReplies = atBottom ? 0 : Math.max(0, completedReplies - repliesSeenRef.current)

  // Orphan turn failure: lastError set but no transcript entry carries it (a
  // turn_failed with no turnId while nothing was streaming). Without this the
  // chat would look idle/successful with the only trace in Notifications.
  const hasFailedTurnEntry = projection.entries.some(
    (entry) => entry.kind === 'assistant' && entry.status === 'failed',
  )
  const composerError = actionError ?? (projection.lastError && !hasFailedTurnEntry ? projection.lastError : null)

  return (
    <ChatShell>
      <CreationBackdrop surface="chat" visible={timelineRows.length === 0} />
      {!ready && timelineRows.length > 0 ? (
        <ChatNotice tone={readiness.kind === 'loading' ? 'neutral' : 'warn'}>{readinessLabel(readiness)}</ChatNotice>
      ) : null}
      {/* Warn only about the CURRENT session: after a restart the replayed
          transcript may carry a previous session's source, but no session is
          live until the next send (which resets the source via
          session_started). */}
      {sessionId !== null && projection.apiKeySource !== null && projection.apiKeySource !== 'none' ? (
        <ChatNotice tone="warn">This session is using an API key, not your subscription.</ChatNotice>
      ) : null}

      <div
        ref={listRef}
        role="log"
        aria-label={`${label} conversation`}
        aria-live="polite"
        onScroll={handleLogScroll}
        className="flex-1 space-y-1 overflow-y-auto px-4 py-4"
      >
        {timelineRows.length === 0 ? (
          !ready ? (
            <ReadinessState
              readiness={readiness}
              canSwitchModel={!modelLocked}
              onSwitchModel={() => setModelMenuOpen(true)}
            />
          ) : isAgentHarness ? (
            <EmptyChatState
              assistantName={assistantName}
              onSuggestion={(text) => {
                setDraft(text)
                composerRef.current?.focus()
              }}
            />
          ) : (
            // Model providers are a plain chat — no tool contract to explain.
            <div className="flex h-full items-center justify-center">
              <p className="max-w-[280px] text-center text-[12px] leading-5 text-[color:var(--text-muted)]">
                No messages yet. Send a prompt to start the conversation.
              </p>
            </div>
          )
        ) : (
          timelineRows.map((row) => (
            <TimelineRow key={row.id} row={row} chrome={chrome} />
          ))
        )}
      </div>

      <div className="relative px-4 pb-3.5 pt-1">
        {slashPickerActive ? (
          <InlineSkillPicker
            ref={slashPickerRef}
            workspaceRoot={workspaceRoot}
            query={draft.slice(1)}
            onPick={applySkillPick}
            onMatchCountChange={(count) => {
              // Non-matching text dismisses; the slash stays literal.
              if (count === 0 && draft.length > 1) setSlashDismissed(true)
            }}
            className="bottom-full left-4"
          />
        ) : null}
        {!atBottom && timelineRows.length > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-1 text-[11.5px] font-medium text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)]"
          >
            {newReplies > 0 ? `↓ ${newReplies} new ${newReplies === 1 ? 'reply' : 'replies'}` : '↓ Jump to latest'}
          </button>
        ) : null}
        <ConversationPendingDock
          pendingApproval={pendingApprovalEntry}
          workspaceName={workspace?.name}
          onApprove={resolveApproval}
          busy={respondingRequestId !== null}
        />

        {/*
         * A turn failure renders as a structured error block in the transcript
         * (with its own Retry), so here we only restate text for action errors
         * that never reach the transcript (start/send/IPC) — plus the orphan
         * case: a turn_failed that attached to no turn (no turnId while nothing
         * was streaming) sets lastError without a failed transcript entry, and
         * must still surface somewhere in the chat.
         */}
        {composerError ? (
          <div className="mb-2 flex items-center justify-between gap-3">
            <TruncatedText as="span" text={composerError} className="min-w-0 text-[12px] leading-5 text-[color:var(--tone-error)]" />
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
         * Queued message (D6/1776): the user typed ahead and committed while the
         * turn was busy. It auto-sends the moment the session unlocks; Cancel
         * drops it before then. Kept truthful so a queued turn is never a
         * silent, invisible pending action.
         */}
        {queuedMessage ? (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-[12px] font-medium leading-5 text-[color:var(--text-default)]">Queued</span>
              <TruncatedText as="span" text={queuedMessage} className="min-w-0 text-[12px] leading-5 text-[color:var(--text-muted)]" />
            </div>
            <GhostButton
              size="sm"
              onClick={() => setQueuedMessage(null)}
              className="shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
            >
              Cancel
            </GhostButton>
          </div>
        ) : null}

        {/*
         * Composer: a single rounded field that holds the textarea and a footer
         * control row (model chip + permission chip + send), so the input reads
         * as one surface. The model lives here — picked before the first
         * message, then locked. While an approval card is pending the disabled
         * placeholder says why the composer is waiting.
         */}
        <div className="rounded-xl border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] transition-colors focus-within:border-[color:var(--accent-primary)]">
          <label htmlFor={`chat-composer-${agentId}`} className="sr-only">
            Message {label}
          </label>
          <textarea
            ref={composerRef}
            id={`chat-composer-${agentId}`}
            value={draft}
            onChange={(event) => {
              const value = event.target.value
              setDraft(value)
              if (!value.startsWith('/')) setSlashDismissed(false)
            }}
            onKeyDown={(event) => {
              // While the slash picker is up, the textarea keeps focus and
              // forwards navigation; Enter picks instead of sending.
              if (slashPickerActive) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (slashPickerRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
                    event.preventDefault()
                    return
                  }
                } else if (event.key === 'Enter' && !event.shiftKey) {
                  if (slashPickerRef.current?.pickActive()) {
                    event.preventDefault()
                    return
                  }
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setSlashDismissed(true)
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submitComposer()
              }
            }}
            placeholder={composerPlaceholder}
            rows={1}
            disabled={composerInputDisabled}
            className={COMPOSER_CLASS}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
            <div className="flex min-w-0 items-center gap-1">
              {isAgentHarness ? (
                <SkillPickerPopover
                  open={skillsMenuOpen}
                  onOpenChange={setSkillsMenuOpen}
                  workspaceRoot={workspaceRoot}
                  onPick={applySkillPick}
                  onManageSkills={() => openConnectorsSurface({ view: 'installed' })}
                />
              ) : null}
              <ModelPickerPill
                label={currentModelLabel}
                locked={modelLocked}
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                groups={modelGroups}
                selectedProviderId={conversation.providerId}
                selectedModelId={conversation.modelId}
                onSelect={selectModel}
                onBrowseProvider={fetchProviderCatalog}
                onAddKey={() => {
                  setModelMenuOpen(false)
                  openSettingsOverlay({ initialTab: 'providers' })
                }}
              />
              {contextLength ? (
                <ContextMeter used={usedTokens} total={contextLength} />
              ) : null}
              {isAgentHarness ? (
                <Tooltip content={`${assistantName} asks for approval before running tools in this workspace`} placement="top">
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-[color:var(--text-muted)]">
                    <LockGlyph className="icon-xs" />
                    Asks before tools
                  </span>
                </Tooltip>
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
                ariaLabel={
                  pending === 'starting' || pending === 'sending'
                    ? 'Sending'
                    : composerBusy
                      ? 'Queue message'
                      : 'Send message'
                }
                onClick={submitComposer}
                disabled={!ready || !draft.trim()}
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
    <div className="relative isolate flex h-full flex-col bg-[color:var(--agent-surface)] text-[12px] text-[color:var(--text-default)]">
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
        {formatTokens(used)}
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
type ModelGroup = {
  providerId: string
  providerLabel: string
  // True for agent-harness providers — the user's own subscription, annotated
  // in the menu so metered API providers are visibly different.
  subscription?: boolean
  // Plain-language reason the provider cannot start sessions; renders the
  // group disabled instead of hiding it.
  unavailable?: string
  models: ConversationProviderModel[]
  // Explicit empty state for a dynamic-catalog provider with no models to list,
  // so it is never dropped nor shown as a silent stale seed. 'add-key' — no key
  // configured; 'no-models' — key present but the live catalog came back empty.
  emptyState?: 'add-key' | 'no-models'
}

function ModelPickerPill({
  label,
  locked,
  open,
  onOpenChange,
  groups,
  selectedProviderId,
  selectedModelId,
  onSelect,
  onBrowseProvider,
  onAddKey,
}: {
  label: string
  locked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ModelGroup[]
  selectedProviderId: string
  selectedModelId: string
  onSelect: (providerId: string, modelId: string) => void
  // Fired when the user opens the picker or filters to a specific provider, so
  // the parent fetches THAT provider's live catalog (never a blanket prefetch).
  // 'all' is not a provider and is not fetched.
  onBrowseProvider: (providerId: string) => void
  // Opens provider settings to configure a missing key for the given provider.
  onAddKey: (providerId: string) => void
}) {
  const [query, setQuery] = useState('')
  // Provider filter chips (Cursor-style): pick one provider to browse, or All.
  // `null` means "not chosen yet" — resolved to the subscription provider when
  // one exists, so opening the picker never starts in a metered catalog.
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
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
  // Default to the subscription provider only when it can actually be picked —
  // an unavailable harness must not leave the at-rest view all-disabled while
  // selectable providers hide behind the filter.
  const defaultFilter = groups.find((group) => group.subscription && !group.unavailable)?.providerId ?? 'all'
  const activeFilter = providerFilter ?? defaultFilter
  const normalized = query.trim().toLowerCase()
  // Search matches the provider as well as the model: "claude" must keep the
  // Claude Code (subscription) group visible even though its models are named
  // Sonnet/Opus/Haiku — otherwise the search silently hides the subscription
  // and leaves only metered lookalikes.
  const searchMatched = groups
    .map((group) => {
      if (!normalized) return group
      if (group.providerLabel.toLowerCase().includes(normalized) || group.providerId.toLowerCase().includes(normalized)) {
        return group
      }
      return {
        ...group,
        models: group.models.filter(
          (model) =>
            model.id.toLowerCase().includes(normalized)
            || (model.displayName?.toLowerCase().includes(normalized) ?? false),
        ),
      }
    })
    // Browsing (no query) keeps every provider group so a key-configured
    // provider never disappears for an empty catalog — its empty state renders
    // inline. A query drops non-matching groups unless the provider name matched.
    .filter((group) => {
      if (!normalized) return true
      const providerMatches =
        group.providerLabel.toLowerCase().includes(normalized) || group.providerId.toLowerCase().includes(normalized)
      return providerMatches || group.models.length > 0
    })
  // Searching looks across every provider (a filter must never hide a search
  // hit); browsing without a query respects the active chip.
  const filtered = normalized ? searchMatched : searchMatched.filter(
    (group) => activeFilter === 'all' || group.providerId === activeFilter,
  )
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          // Load the catalog for the provider the picker opens onto.
          if (activeFilter !== 'all') onBrowseProvider(activeFilter)
        }
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
      <div className="flex max-h-[400px] w-[300px] flex-col overflow-hidden">
        {totalModels > 8 || groups.length > 1 ? (
          // Search + the shared filter glyph, matching the panel-toolbar
          // pattern (Backlog, agent composer): search is the at-rest control,
          // the provider axis collapses behind FilterMenu.
          <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
            <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] focus:outline-none"
            />
            {groups.length > 1 ? (
              <FilterMenu
                ariaLabel="Filter models by provider"
                groups={[
                  {
                    label: 'Provider',
                    items: [
                      { value: 'all', label: 'All providers' },
                      ...groups.map((group) => ({
                        value: group.providerId,
                        label: group.subscription ? `${group.providerLabel} (subscription)` : group.providerLabel,
                      })),
                    ],
                    value: activeFilter,
                    // The subscription-first default view is the baseline, not
                    // an applied filter.
                    defaultValue: defaultFilter,
                    onChange: (value) => {
                      setProviderFilter(value)
                      // Fetch the newly-selected provider's live catalog.
                      if (value !== 'all') onBrowseProvider(value)
                    },
                  },
                ]}
              />
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-[color:var(--text-muted)]" role="status">
              {normalized ? `No models match “${query.trim()}”` : 'No providers available'}
            </div>
          ) : (
            filtered.map((group) => (
              <div key={group.providerId} className="py-0.5">
                <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-1.5">
                  <span className="text-[11px] font-semibold text-[color:var(--text-default)]">{group.providerLabel}</span>
                  <span className="text-[10.5px] text-[color:var(--text-subtle)]">
                    {group.unavailable
                      ? 'not available'
                      : group.subscription
                        ? 'your Claude subscription'
                        : group.emptyState === 'add-key'
                          ? 'needs an API key'
                          : 'uses your API key'}
                  </span>
                </div>
                {group.unavailable ? (
                  <p className="px-2.5 pb-1 text-[11px] leading-4 text-[color:var(--text-muted)]">{group.unavailable}</p>
                ) : group.models.length === 0 ? (
                  // A key-configured provider with an empty catalog stays visible
                  // with an explicit state instead of vanishing or showing a
                  // stale seed. Missing key offers a direct route to add one.
                  group.emptyState === 'add-key' ? (
                    <div className="px-2.5 pb-1.5 pt-0.5">
                      <p className="pb-1 text-[11px] leading-4 text-[color:var(--text-muted)]">
                        Add an API key to browse this provider’s models.
                      </p>
                      <button
                        type="button"
                        onClick={() => onAddKey(group.providerId)}
                        className="rounded px-2 py-1 text-[12px] font-medium text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--bg-hover)]"
                      >
                        Add key in Settings
                      </button>
                    </div>
                  ) : (
                    <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] leading-4 text-[color:var(--text-muted)]" role="status">
                      No models returned for this provider.
                    </p>
                  )
                ) : null}
                {group.models.map((model) => {
                  const isCurrent = group.providerId === selectedProviderId && model.id === selectedModelId
                  return (
                    <button
                      key={`${group.providerId}:${model.id}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      disabled={Boolean(group.unavailable)}
                      onClick={() => onSelect(group.providerId, model.id)}
                      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-default disabled:opacity-45 ${
                        isCurrent
                          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-default)]'
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

// Square composer action (30px, rounded-8 per the approved mockup):
// accent-filled send, or a bordered neutral stop while a turn streams. Flat
// fill only — no gradient/shadow — per the app-shell button rules.
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
      : 'border border-[color:var(--border-default)] bg-[color:var(--bg-hover)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-active)] disabled:hover:bg-[color:var(--bg-hover)]'
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-default disabled:opacity-40 ${toneClass}`}
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

// The shared card shell docked above the composer: eyebrow row with an earned
// status dot, content, then a footer of keyboard hints + actions. Question,
// permission and plan requests all render inside it so pending asks read as
// one consistent surface.
function DockShell({
  dotTone,
  eyebrow,
  hints,
  actions,
  onKeyDown,
  containerRef,
  ariaLabel,
  children,
}: {
  dotTone: 'warn' | 'error' | 'accent'
  eyebrow: string
  hints?: React.ReactNode
  actions: React.ReactNode
  onKeyDown?: (event: React.KeyboardEvent) => void
  containerRef?: React.Ref<HTMLDivElement>
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mb-2 max-h-[60vh] overflow-y-auto rounded-xl border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] outline-none"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5">
        <StatusDot tone={dotTone} label={eyebrow} />
        <span
          // design-tokens-allow: approved MC-1478 mockup eyebrow (10.5px/600 uppercase +0.08em) per the item's implementation spec
          className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-subtle)]"
        >
          {eyebrow}
        </span>
      </div>
      {children}
      <div className="flex items-center gap-2.5 px-3.5 pb-3 pt-2">
        {hints ? <span className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">{hints}</span> : null}
        <div className="ml-auto flex shrink-0 gap-2">{actions}</div>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-1 py-px font-sans text-[10px] font-medium leading-none text-[color:var(--text-muted)]">
      {children}
    </kbd>
  )
}

// Humanize the tool behind a permission request for the eyebrow.
function permissionActionLabel(action?: string): string {
  switch (action) {
    case 'Bash':
      return 'Run command'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Edit file'
    case 'Write':
      return 'Write file'
    case 'Read':
      return 'Read file'
    case 'WebFetch':
      return 'Fetch URL'
    case 'WebSearch':
      return 'Web search'
    default:
      return action ?? 'Tool request'
  }
}

function ConversationPendingDock({
  pendingApproval,
  workspaceName,
  onApprove,
  busy,
}: {
  pendingApproval?: Extract<TranscriptEntry, { kind: 'approval' }>
  workspaceName?: string
  onApprove: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
}) {
  if (!pendingApproval) return null
  if (pendingApproval.requestKind === 'question' && pendingApproval.questions?.length) {
    return (
      <ConversationQuestionCard
        key={pendingApproval.requestId}
        requestId={pendingApproval.requestId}
        questions={pendingApproval.questions}
        onAnswer={onApprove}
        busy={busy}
      />
    )
  }
  if (pendingApproval.requestKind === 'plan') {
    return <ConversationPlanCard key={pendingApproval.requestId} entry={pendingApproval} onApprove={onApprove} busy={busy} />
  }
  return (
    <ConversationPermissionCard
      key={pendingApproval.requestId}
      entry={pendingApproval}
      workspaceName={workspaceName}
      onApprove={onApprove}
      busy={busy}
    />
  )
}

// Permission request: lead with WHAT (the literal command in a terminal block
// for Bash, the summary otherwise) and WHERE (the workspace), not tool jargon.
// Enter approves, Escape denies.
function ConversationPermissionCard({
  entry,
  workspaceName,
  onApprove,
  busy,
}: {
  entry: Extract<TranscriptEntry, { kind: 'approval' }>
  workspaceName?: string
  onApprove: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [])
  const command = entry.action === 'Bash' ? toolObject({ name: 'Bash', summary: entry.summary }) : ''
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onApprove(entry.requestId, true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onApprove(entry.requestId, false)
    }
  }
  return (
    <DockShell
      dotTone="warn"
      eyebrow={`Permission · ${permissionActionLabel(entry.action)}`}
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Permission request"
      hints={
        <>
          <span className="inline-flex items-center gap-1"><Kbd>⏎</Kbd> approve</span>
          <span className="inline-flex items-center gap-1"><Kbd>⎋</Kbd> deny</span>
        </>
      }
      actions={
        <>
          <GhostButton
            size="sm"
            onClick={() => onApprove(entry.requestId, false)}
            disabled={busy}
            className="border border-[color:var(--border-default)] bg-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
          >
            Deny
          </GhostButton>
          <PrimaryButton size="sm" onClick={() => onApprove(entry.requestId, true)} disabled={busy}>
            Approve <Kbd>⏎</Kbd>
          </PrimaryButton>
        </>
      }
    >
      {command ? (
        <div className="mx-3.5 mt-2 overflow-x-auto rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] px-3 py-2.5 font-mono text-[12px] text-[color:var(--terminal-fg)]">
          <span className="select-none text-[color:var(--accent-primary)]">$ </span>
          {command}
        </div>
      ) : (
        <p className="px-3.5 pt-1.5 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
          {entry.summary}
        </p>
      )}
      {workspaceName ? (
        <div className="flex items-center gap-1.5 px-3.5 pt-1.5 text-[11.5px] text-[color:var(--text-subtle)]">
          <FolderGlyph className="icon-xs" />
          in {workspaceName}
        </div>
      ) : null}
    </DockShell>
  )
}

function ConversationPlanCard({
  entry,
  onApprove,
  busy,
}: {
  entry: Extract<TranscriptEntry, { kind: 'approval' }>
  onApprove: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [])
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onApprove(entry.requestId, true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onApprove(entry.requestId, false)
    }
  }
  return (
    <DockShell
      dotTone="warn"
      eyebrow="Plan · Review & approve"
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Plan approval"
      hints={
        <>
          <span className="inline-flex items-center gap-1"><Kbd>⏎</Kbd> approve</span>
          <span className="inline-flex items-center gap-1"><Kbd>⎋</Kbd> keep planning</span>
        </>
      }
      actions={
        <>
          <GhostButton
            size="sm"
            onClick={() => onApprove(entry.requestId, false)}
            disabled={busy}
            className="border border-[color:var(--border-default)] bg-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
          >
            Keep planning
          </GhostButton>
          <PrimaryButton size="sm" onClick={() => onApprove(entry.requestId, true)} disabled={busy}>
            Approve plan <Kbd>⏎</Kbd>
          </PrimaryButton>
        </>
      }
    >
      {entry.plan?.trim() ? (
        <div className="mx-3.5 mt-2 max-h-64 overflow-y-auto rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-3 py-2.5 text-[12px] leading-5">
          {renderMarkdown(entry.plan)}
        </div>
      ) : (
        <p className="px-3.5 pt-1.5 text-[12.5px] leading-5 text-[color:var(--text-default)]">{entry.summary}</p>
      )}
    </DockShell>
  )
}

// Structured question card, one question at a time ("1 of N" when the model
// bundles several). Keyboard-first: 1–9 pick options, ↑↓ move, ⏎ advances or
// submits, ⎋ dismisses. Answers submit with the ORIGINAL option labels so the
// tool call round-trips; only the display strips "(Recommended)".
function ConversationQuestionCard({
  requestId,
  questions,
  onAnswer,
  busy,
}: {
  requestId: string
  questions: ConversationQuestion[]
  onAnswer: (requestId: string, approved: boolean, answers?: Record<string, string>) => void
  busy: boolean
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [stepIndex])

  const question = questions[Math.min(stepIndex, questions.length - 1)]
  if (!question) return null
  const picks = selected[question.question] ?? []
  const isLast = stepIndex >= questions.length - 1

  const answerFor = (target: ConversationQuestion): string => {
    const targetPicks = selected[target.question] ?? []
    const other = otherText[target.question]?.trim()
    return [...targetPicks, ...(other ? [other] : [])].join(', ')
  }
  const currentAnswered = answerFor(question).length > 0

  const toggleOption = (label: string): void => {
    setSelected((current) => {
      const currentPicks = current[question.question] ?? []
      if (question.multiSelect) {
        const next = currentPicks.includes(label)
          ? currentPicks.filter((value) => value !== label)
          : [...currentPicks, label]
        return { ...current, [question.question]: next }
      }
      return { ...current, [question.question]: currentPicks.includes(label) ? [] : [label] }
    })
  }

  const moveSelection = (delta: number): void => {
    if (question.multiSelect || question.options.length === 0) return
    setSelected((current) => {
      const currentPicks = current[question.question] ?? []
      const labels = question.options.map((option) => option.label)
      const index = currentPicks[0] ? labels.indexOf(currentPicks[0]) : -1
      const next = labels[(index + delta + labels.length) % labels.length]
      return next ? { ...current, [question.question]: [next] } : current
    })
  }

  const advance = (): void => {
    if (!currentAnswered || busy) return
    if (!isLast) {
      setStepIndex((index) => index + 1)
      return
    }
    const answers: Record<string, string> = {}
    for (const target of questions) answers[target.question] = answerFor(target)
    onAnswer(requestId, true, answers)
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (busy) return
    if (event.key >= '1' && event.key <= '9') {
      const option = question.options[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        toggleOption(option.label)
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      advance()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onAnswer(requestId, false)
    }
  }

  const eyebrow = `Question${question.header ? ` · ${question.header}` : ''} · ${stepIndex + 1} of ${questions.length}`
  return (
    <DockShell
      dotTone="warn"
      eyebrow={eyebrow}
      containerRef={containerRef}
      onKeyDown={handleKeyDown}
      ariaLabel="Question from the agent"
      hints={
        <>
          {!question.multiSelect && question.options.length > 1 ? (
            <span className="inline-flex items-center gap-1"><Kbd>↑↓</Kbd> choose</span>
          ) : null}
          {question.options.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>1–{Math.min(question.options.length, 9)}</Kbd> {question.multiSelect ? 'toggle' : 'pick'}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1"><Kbd>⏎</Kbd> {isLast ? 'answer' : 'next'}</span>
        </>
      }
      actions={
        <>
          <GhostButton
            size="sm"
            onClick={() => onAnswer(requestId, false)}
            disabled={busy}
            className="border border-[color:var(--border-default)] bg-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
          >
            Dismiss
          </GhostButton>
          <PrimaryButton size="sm" onClick={advance} disabled={busy || !currentAnswered}>
            {isLast ? 'Answer' : 'Next'} <Kbd>⏎</Kbd>
          </PrimaryButton>
        </>
      }
    >
      <p className="px-3.5 pt-1.5 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
        {question.question}
      </p>
      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.header ?? question.question}
        className="flex flex-col px-2 pt-1"
      >
        {question.options.map((option, index) => {
          const checked = picks.includes(option.label)
          const parsed = parseOptionLabel(option.label)
          return (
            <button
              key={option.label}
              type="button"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={busy}
              onClick={() => toggleOption(option.label)}
              className={`flex items-start gap-2.5 rounded-lg border-l-[3px] px-2.5 py-2 text-left transition-colors ${
                checked
                  ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                  : 'border-l-transparent hover:bg-[color:var(--bg-hover)]'
              }`}
            >
              {index < 9 ? (
                <span
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 rounded border px-1 py-px font-mono text-[10px] font-medium leading-none ${
                    checked
                      ? 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]'
                      : 'border-[color:var(--border-strong)] text-[color:var(--text-subtle)]'
                  }`}
                >
                  {index + 1}
                </span>
              ) : null}
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-5 text-[color:var(--text-strong)]">
                  {parsed.text}
                  {parsed.recommended ? (
                    <span
                      // design-tokens-allow: approved MC-1478 mockup renders "Recommended" as a quiet uppercase accent label inline with the option title
                      className="ml-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[color:var(--accent-primary)]"
                    >
                      Recommended
                    </span>
                  ) : null}
                </span>
                {option.description ? (
                  <span className="mt-px block text-[12px] leading-[1.45] text-[color:var(--text-muted)]">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
      {question.allowFreeText !== false ? (
        <div className="px-[18px] pb-1 pt-1.5">
          <input
            type="text"
            value={otherText[question.question] ?? ''}
            onChange={(event) =>
              setOtherText((current) => ({ ...current, [question.question]: event.target.value }))
            }
            onKeyDown={(event) => {
              // The card's container hotkeys (digits pick options, arrows move)
              // must not fire while typing a free-text answer.
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                advance()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onAnswer(requestId, false)
              }
            }}
            placeholder="Something else…"
            disabled={busy}
            aria-label={`Other answer for: ${question.question}`}
            className="w-full rounded-lg border border-[color:var(--border-subtle)] bg-transparent px-2.5 py-2 text-[12.5px] text-[color:var(--text-default)] placeholder:text-[color:var(--text-subtle)] focus:border-[color:var(--accent-primary)] focus:outline-none"
          />
        </div>
      ) : null}
    </DockShell>
  )
}

function TimelineRow({ row, chrome }: { row: ConversationTimelineRow; chrome: TimelineChrome }) {
  return (
    <div className="conversation-row-enter" data-conversation-row-kind={row.kind}>
      {row.kind === 'user' ? <UserTimelineRow entry={row.entry} /> : null}
      {row.kind === 'assistant' ? <AssistantTurnBlock entry={row.entry} tools={row.tools} chrome={chrome} /> : null}
      {row.kind === 'approval' ? <ResolvedDecisionRow entry={row.entry} /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
}

// User message: quiet right-aligned card, no chrome.
function UserTimelineRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end pb-6">
      <div className="max-w-[76%] rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
        <p className="whitespace-pre-wrap text-[13px] leading-normal text-[color:var(--text-strong)]">{entry.text}</p>
      </div>
    </div>
  )
}

// One assistant turn: byline → thought disclosure → work timeline → prose.
// Glyph-led, no avatar bubble; the reading text gets real size, chrome stays
// small and quiet.
function AssistantTurnBlock({
  entry,
  tools,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  tools: Extract<TranscriptEntry, { kind: 'tool' }>[]
  chrome: TimelineChrome
}) {
  const modelLabel = chrome.modelLabelFor(entry.modelId)
  const metaParts = [
    ...(modelLabel && modelLabel !== chrome.assistantName ? [modelLabel] : []),
    ...(entry.startedAt ? [formatClockTime(entry.startedAt)] : []),
  ]
  return (
    <div className="pb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--text-strong)]">
          <SparkleGlyph className="icon-sm text-[color:var(--accent-primary)]" />
          {chrome.assistantName}
        </span>
        {metaParts.length > 0 ? (
          <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">{metaParts.join(' · ')}</span>
        ) : null}
      </div>
      {entry.reasoning.trim() ? (
        <ThoughtRow reasoning={entry.reasoning} durationMs={entry.reasoningDurationMs} />
      ) : null}
      {tools.length > 0 ? <WorkTimeline tools={tools} live={entry.status === 'streaming'} /> : null}
      {entry.text.trim() ? <div className="max-w-[68ch]">{renderMarkdown(entry.text)}</div> : null}
      {entry.status === 'interrupted' ? (
        <span className="text-[11px] text-[color:var(--text-subtle)]">Interrupted</span>
      ) : null}
      {entry.status === 'failed' ? <TurnErrorBlock entry={entry} chrome={chrome} /> : null}
    </div>
  )
}

// "Thought for Ns" disclosure; expanded reasoning reads as a quiet aside.
function ThoughtRow({ reasoning, durationMs }: { reasoning: string; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mb-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 pl-1 pr-2 text-[11.5px] text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-muted)]"
      >
        <ChevronRightGlyph className={`icon-xs transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {durationMs !== undefined ? `Thought for ${formatStepDuration(durationMs)}` : 'Thought'}
      </button>
      {expanded ? (
        <p className="mb-1 mt-1 max-w-[68ch] whitespace-pre-wrap pl-1 text-[12.5px] italic leading-5 text-[color:var(--text-muted)]">
          {reasoning}
        </p>
      ) : null}
    </div>
  )
}

// The work timeline: a collapsible "Worked for <elapsed> · N steps" header over
// a hairline rail of verb-led steps. The live step carries the only pulsing
// accent dot on screen.
// Long turns can run hundreds of tools; the rail shows the most recent steps
// (the live tail is what matters) behind a "Show N earlier steps" expander so
// a big turn cannot flood the transcript with unbounded rows.
const MAX_VISIBLE_WORK_STEPS = 12

function WorkTimeline({ tools, live }: { tools: Extract<TranscriptEntry, { kind: 'tool' }>[]; live: boolean }) {
  const [open, setOpen] = useState(true)
  const [showAllSteps, setShowAllSteps] = useState(false)
  const hiddenSteps = showAllSteps ? 0 : Math.max(0, tools.length - MAX_VISIBLE_WORK_STEPS)
  const visibleTools = hiddenSteps > 0 ? tools.slice(hiddenSteps) : tools
  const first = tools[0]
  const lastDone = [...tools].reverse().find((tool) => tool.completedAt !== undefined)
  const elapsedMs =
    first?.startedAt !== undefined && lastDone?.completedAt !== undefined
      ? Math.max(0, lastDone.completedAt - first.startedAt)
      : undefined
  const working = live || tools.some((tool) => tool.status === 'running')
  return (
    <div className="mb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 pl-1 pr-2 text-[11.5px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
      >
        <ChevronRightGlyph className={`icon-xs text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-90' : ''}`} />
        {working ? (
          <span className="inline-flex items-baseline gap-1 tabular-nums">
            Working{first?.startedAt !== undefined ? <>&nbsp;·&nbsp;<LiveElapsed startedAt={first.startedAt} /></> : null}
          </span>
        ) : (
          <span className="tabular-nums">
            {elapsedMs !== undefined ? `Worked for ${formatStepDuration(elapsedMs)} · ` : ''}
            {tools.length} {tools.length === 1 ? 'step' : 'steps'}
          </span>
        )}
      </button>
      {open ? (
        <div className="ml-[5px] mt-1.5 flex flex-col gap-0.5 border-l border-[color:var(--border-default)] pl-4">
          {hiddenSteps > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllSteps(true)}
              className="self-start rounded-md px-2 py-[3px] text-left text-[11.5px] text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-muted)]"
            >
              Show {hiddenSteps} earlier {hiddenSteps === 1 ? 'step' : 'steps'}
            </button>
          ) : null}
          {visibleTools.map((tool) => (
            <WorkStep key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function WorkStep({ tool }: { tool: Extract<TranscriptEntry, { kind: 'tool' }> }) {
  const running = tool.status === 'running'
  const object = toolObject(tool)
  const durationMs =
    tool.startedAt !== undefined && tool.completedAt !== undefined
      ? Math.max(0, tool.completedAt - tool.startedAt)
      : undefined
  const showOutput = !running && tool.name === 'Bash' && Boolean(tool.output?.trim())
  return (
    <>
      <div
        className={`relative flex items-baseline gap-2 rounded-md px-2 py-[3px] text-[12px] ${
          running ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'
        }`}
      >
        <StatusDot
          tone={running ? 'accent' : 'neutral'}
          pulse={running}
          className="absolute -left-[19px] top-[9px]"
        />
        <span className="shrink-0 font-medium text-[color:var(--text-default)]">{toolVerb(tool.name, running)}</span>
        {object ? (
          <TruncatedText
            as="span"
            text={running ? `${object}…` : object}
            className="min-w-0 font-mono text-[11.5px] text-[color:var(--text-muted)]"
          />
        ) : null}
        {typeof tool.addedLines === 'number' && tool.addedLines > 0 ? (
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-[color:var(--diff-added)]">
            +{tool.addedLines}
          </span>
        ) : null}
        {typeof tool.removedLines === 'number' && tool.removedLines > 0 ? (
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-[color:var(--diff-removed)]">
            −{tool.removedLines}
          </span>
        ) : null}
        {!running && durationMs !== undefined ? (
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {formatStepDuration(durationMs)}
          </span>
        ) : null}
        {running ? <span className="sr-only">running</span> : null}
      </div>
      {showOutput ? <StepOutput output={tool.output ?? ''} /> : null}
    </>
  )
}

// Command output in a terminal-toned block; ✓ lines read as passes. Collapsed
// past six lines so a long test run doesn't drown the timeline.
const STEP_OUTPUT_COLLAPSED_LINES = 6

function StepOutput({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = output.replace(/\n+$/, '').split('\n')
  const collapsed = !expanded && lines.length > STEP_OUTPUT_COLLAPSED_LINES
  const visible = collapsed ? lines.slice(0, STEP_OUTPUT_COLLAPSED_LINES) : lines
  return (
    <div className="mb-1.5 ml-2 mt-0.5 overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)]">
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-[color:var(--terminal-fg)]">
        {visible.map((line, index) => (
          <div key={index} className={/^\s*✓/.test(line) ? 'text-[color:var(--tone-good)]' : undefined}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {lines.length > STEP_OUTPUT_COLLAPSED_LINES ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="block w-full border-t border-[color:var(--border-subtle)] px-3 py-1 text-left text-[11px] text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-muted)]"
        >
          {collapsed ? `Show ${lines.length - STEP_OUTPUT_COLLAPSED_LINES} more lines` : 'Show less'}
        </button>
      ) : null}
    </div>
  )
}

// A failed turn is a first-class transcript block: what happened in human
// words, the fix as a real action, raw provider detail folded away. Error tone
// appears on the 6px dot only — never as walls or borders.
function TurnErrorBlock({
  entry,
  chrome,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  chrome: TimelineChrome
}) {
  const [showDetails, setShowDetails] = useState(false)
  const detail = entry.failureDetail ?? entry.failureReason
  const authShaped = isAuthShapedFailure(`${entry.failureReason ?? ''} ${entry.failureDetail ?? ''}`)
  const message = authShaped
    ? 'The session could not authenticate — usually a sign your sign-in expired. Run `claude login` in a terminal, then retry. Your message is kept; retrying resumes the same conversation.'
    : 'Something went wrong while responding. Your message is kept; retrying resumes the same conversation.'
  return (
    <div className="mt-1 max-w-[68ch] rounded-[10px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[color:var(--text-strong)]">
        <StatusDot tone="error" label="Turn failed" />
        {chrome.assistantName} couldn’t finish this turn
      </div>
      <p className="mb-2.5 mt-1 text-[12.5px] leading-[1.55] text-[color:var(--text-muted)]">{message}</p>
      <div className="flex items-center gap-2">
        {chrome.retryTurnId === entry.turnId ? (
          <PrimaryButton size="sm" onClick={chrome.onRetry} disabled={chrome.retryDisabled}>
            Retry
          </PrimaryButton>
        ) : null}
        {detail ? (
          <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((value) => !value)}
            className="ml-auto text-[11.5px] text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-muted)]"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
        ) : null}
      </div>
      {showDetails && detail ? (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--terminal-bg)] px-3 py-2 font-mono text-[11px] leading-[1.6] text-[color:var(--text-subtle)]">
          {detail}
        </pre>
      ) : null}
    </div>
  )
}

// Resolved requests stay in the transcript as quote-style decision records —
// the question muted, the chosen answer strong with an accent check.
function ResolvedDecisionRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'approval' }> }) {
  const answerLine = (text: string, good: boolean): React.ReactNode => (
    <div className="mt-0.5 flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--text-strong)]">
      {good ? (
        <CheckGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
      ) : (
        <StatusDot tone="error" label="Denied" />
      )}
      {text}
    </div>
  )
  return (
    <div className="pb-6">
      <div className="max-w-[68ch] border-l-2 border-[color:var(--border-default)] py-0.5 pl-3.5">
        {entry.requestKind === 'question' && entry.questions?.length ? (
          <div className="space-y-2">
            {entry.questions.map((question) => {
              const answer = entry.answers?.[question.question]
              return (
                <div key={question.question}>
                  <div className="text-[12px] leading-5 text-[color:var(--text-muted)]">{question.question}</div>
                  {entry.status === 'approved' && answer
                    ? answerLine(answer, true)
                    : entry.status === 'denied'
                      ? (
                          <div className="mt-0.5 text-[12px] italic text-[color:var(--text-subtle)]">
                            Dismissed without answering
                          </div>
                        )
                      : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div>
            <div className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              {entry.requestKind === 'plan' ? 'Proposed a plan' : entry.summary}
            </div>
            {entry.status === 'approved'
              ? answerLine(entry.requestKind === 'plan' ? 'Plan approved' : 'Approved', true)
              : entry.status === 'denied'
                ? answerLine(entry.requestKind === 'plan' ? 'Sent back for more planning' : 'Denied', false)
                : (
                    <div className="mt-0.5 text-[12px] italic text-[color:var(--text-subtle)]">
                      Cancelled with the turn
                    </div>
                  )}
          </div>
        )}
      </div>
    </div>
  )
}

// Live status line while a turn streams: the latest step verb shimmers quietly
// (plain muted text under prefers-reduced-motion).
function WorkingTimelineRow({ row }: { row: Extract<ConversationTimelineRow, { kind: 'working' }> }) {
  return (
    <div className="pb-2 pl-0.5">
      <span className="chat-shimmer text-[12px] font-medium text-[color:var(--text-muted)]">{row.label}</span>
    </div>
  )
}

// First-run empty state: the contract in one sentence, three real starting
// prompts, and the cost answer before anyone asks. No decorative hero.
function EmptyChatState({
  assistantName,
  onSuggestion,
}: {
  assistantName: string
  onSuggestion: (text: string) => void
}) {
  const suggestions: Array<{ text: string; glyph: React.ReactNode }> = [
    { text: 'Explain how this codebase is organized', glyph: <MagnifierGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" /> },
    { text: 'Add a small feature and tests for it', glyph: <PlusGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" /> },
    { text: 'Review my uncommitted changes', glyph: <ShieldGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" /> },
  ]
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <ChatGlyph className="mb-3.5 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
      <h2 className="mb-1 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
        Ask {assistantName} about this workspace
      </h2>
      <p className="mb-5 max-w-[44ch] text-[12.5px] leading-[1.55] text-[color:var(--text-muted)]">
        It reads your code, runs tools with your approval, and remembers the conversation across restarts.
      </p>
      <div className="flex w-full max-w-[420px] flex-col gap-1.5 text-left">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.text}
            type="button"
            onClick={() => onSuggestion(suggestion.text)}
            className="group flex items-center gap-2.5 rounded-[9px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5 text-left text-[12.5px] text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]"
          >
            {suggestion.glyph}
            <span className="min-w-0 flex-1">{suggestion.text}</span>
            <span aria-hidden="true" className="text-[11px] text-[color:var(--text-subtle)] opacity-0 transition-opacity group-hover:opacity-100">
              ⏎
            </span>
          </button>
        ))}
      </div>
      <p className="mt-5 text-[11px] text-[color:var(--text-subtle)]">
        Runs on your Claude subscription · asks before using tools
      </p>
    </div>
  )
}

// Provider-not-ready is a full centered state with a plain-language next step —
// never a bare red sentence. Real actions only.
function ReadinessState({
  readiness,
  canSwitchModel,
  onSwitchModel,
}: {
  readiness: ChatReadiness
  canSwitchModel: boolean
  onSwitchModel: () => void
}) {
  if (readiness.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-[color:var(--text-muted)]">Checking provider…</p>
      </div>
    )
  }
  const title =
    readiness.kind === 'provider-unavailable'
      ? 'This conversation provider isn’t installed'
      : readiness.kind === 'model-unavailable'
        ? 'This model isn’t available'
        : readiness.kind === 'missing-key'
          ? 'Add an API key to start'
          : readiness.kind === 'no-workspace-folder'
            ? 'Open a workspace folder first'
            : 'Conversation is unavailable'
  const offerSwitch =
    canSwitchModel
    && (readiness.kind === 'provider-unavailable' || readiness.kind === 'model-unavailable' || readiness.kind === 'missing-key')
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <ChatGlyph className="mb-3.5 h-[30px] w-[30px] text-[color:var(--text-subtle)]" />
      <h2 className="mb-1 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">{title}</h2>
      <p className="mb-5 max-w-[44ch] text-[12.5px] leading-[1.55] text-[color:var(--text-muted)]">
        {readinessLabel(readiness)}
      </p>
      {offerSwitch ? (
        <GhostButton
          size="sm"
          onClick={onSwitchModel}
          className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]"
        >
          Use another model
        </GhostButton>
      ) : null}
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

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function SparkleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5l1.7 4.1 4.3.4-3.2 2.9.9 4.3L8 11l-3.7 2.2.9-4.3L2 6l4.3-.4L8 1.5z" fill="currentColor" />
    </svg>
  )
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5L5 9l4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronRightGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function LockGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2.5" y="6" width="9" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6V4.5a2.5 2.5 0 015 0V6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3h2l1 1.5h4A1.5 1.5 0 0112 6v4a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 012 10V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function MagnifierGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6.2" cy="6.2" r="3.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 9l2.8 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 7h9M7 2.5v9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function ShieldGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1.8l5 2v3.4c0 3-2.1 5-5 6-2.9-1-5-3-5-6V3.8l5-2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

