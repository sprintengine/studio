import assert from 'node:assert/strict'

import type { ConversationEvent, ConversationEventType } from '../../../../shared/conversation-runtime'
import { projectConversation, readinessLabel, stopDisabledForPending, type TranscriptEntry } from './AgentChatView'

let seq = 0
function ev(type: ConversationEventType, payload?: Record<string, unknown>): ConversationEvent {
  seq += 1
  return {
    id: `e-${seq}`,
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    type,
    createdAt: seq,
    payload,
  }
}

function assistant(entries: TranscriptEntry[], turnId: string) {
  const found = entries.find((e) => e.kind === 'assistant' && e.turnId === turnId)
  assert.ok(found && found.kind === 'assistant', `assistant entry for ${turnId}`)
  return found as Extract<TranscriptEntry, { kind: 'assistant' }>
}

// --- empty / idle ----------------------------------------------------------

const empty = projectConversation([], [])
assert.equal(empty.sessionStatus, 'idle')
assert.equal(empty.activeTurn, false)
assert.equal(empty.entries.length, 0)
assert.equal(empty.lastError, null)

// --- streaming turn then completion (mock happy path) ----------------------

const T1 = 'turn-1'
const streaming = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: T1 }),
    ev('content_delta', { turnId: T1, text: 'Hello ' }),
    ev('content_delta', { turnId: T1, text: 'world' }),
  ],
  [{ id: 'u1', text: 'hi' }]
)
assert.equal(streaming.sessionStatus, 'ready')
assert.equal(streaming.activeTurn, true, 'turn without completion is active')
const streamingAssistant = assistant(streaming.entries, T1)
assert.equal(streamingAssistant.text, 'Hello world', 'content deltas accumulate in order')
assert.equal(streamingAssistant.status, 'streaming')
// user turn renders before its assistant turn
assert.equal(streaming.entries[0]?.kind, 'user')
assert.equal(streaming.entries[1]?.kind, 'assistant')

// --- approval requested -> approved -> usage -> completed ------------------

const approved = projectConversation(
  [
    ev('turn_started', { turnId: T1 }),
    ev('content_delta', { turnId: T1, text: 'Working' }),
    ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'May I proceed?' }),
    ev('approval_resolved', { turnId: T1, requestId: 'r1', approved: true }),
    ev('usage_updated', { turnId: T1, inputTokens: 4, outputTokens: 8 }),
    ev('turn_completed', { turnId: T1 }),
  ],
  [{ id: 'u1', text: 'go' }]
)
assert.equal(approved.awaitingApproval, false, 'resolved approval is no longer awaiting')
assert.equal(approved.activeTurn, false)
assert.equal(assistant(approved.entries, T1).status, 'complete')
assert.deepEqual(approved.usage, { inputTokens: 4, outputTokens: 8 })
const approvalEntry = approved.entries.find((e) => e.kind === 'approval')
assert.ok(approvalEntry && approvalEntry.kind === 'approval')
assert.equal(approvalEntry.status, 'approved')

// --- pending approval gates the turn --------------------------------------

const pendingApproval = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'Need approval' }),
])
assert.equal(pendingApproval.awaitingApproval, true)
const pendingEntry = pendingApproval.entries.find((e) => e.kind === 'approval')
assert.ok(pendingEntry && pendingEntry.kind === 'approval' && pendingEntry.status === 'pending')

// --- denied approval fails the turn (mock contract) -----------------------

const denied = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'Need approval' }),
  ev('approval_resolved', { turnId: T1, requestId: 'r1', approved: false }),
  ev('turn_failed', { turnId: T1, reason: 'approval_denied' }),
])
assert.equal(assistant(denied.entries, T1).status, 'failed')
assert.equal(denied.lastError, 'approval_denied', 'a real failure surfaces an actionable error')

// --- interruption is not an error (explicit turnId variant) ---------------

const interrupted = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('content_delta', { turnId: T1, text: 'partial' }),
  ev('turn_failed', { turnId: T1, reason: 'interrupted' }),
])
assert.equal(assistant(interrupted.entries, T1).status, 'interrupted')
assert.equal(interrupted.lastError, null, 'interruption is a state, not an error')
assert.equal(interrupted.activeTurn, false)

// --- real mock-provider interrupt: turn_failed WITHOUT turnId --------------
// The mock provider's interrupt() emits `turn_failed { reason: 'interrupted' }`
// with no turnId (src/main/providers/mock-conversation-provider.ts). Replays the
// actual start -> send (which requests approval) -> Stop sequence: the
// projection must still end the active turn, drop the pending-approval gate, and
// render the interrupted state so the UI does not stay stuck responding.
const mockInterrupted = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: T1 }),
    ev('content_delta', { turnId: T1, text: 'Mock response for: hi' }),
    ev('approval_requested', {
      turnId: T1,
      requestId: 'r1',
      action: 'mock_approval',
      summary: 'Mock provider requests approval to complete the turn.',
    }),
    ev('turn_failed', { reason: 'interrupted' }),
  ],
  [{ id: 'u1', text: 'hi' }]
)
assert.equal(mockInterrupted.activeTurn, false, 'Stop ends the active turn even without a turnId on the interrupt event')
assert.equal(mockInterrupted.awaitingApproval, false, 'a pending approval no longer blocks the composer after interrupt')
assert.equal(mockInterrupted.lastError, null, 'interruption is a state, not an error')
assert.equal(assistant(mockInterrupted.entries, T1).status, 'interrupted')
const mockApproval = mockInterrupted.entries.find((e) => e.kind === 'approval')
assert.ok(mockApproval && mockApproval.kind === 'approval')
assert.equal(mockApproval.status, 'cancelled', 'the unresolved approval is cancelled by the interrupt')

// --- tool start/output cards ----------------------------------------------

const withTool = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('tool_started', { turnId: T1, callId: 'c1', name: 'search' }),
  ev('tool_output', { turnId: T1, callId: 'c1', output: 'result rows' }),
  ev('turn_completed', { turnId: T1 }),
])
const toolEntry = withTool.entries.find((e) => e.kind === 'tool')
assert.ok(toolEntry && toolEntry.kind === 'tool')
assert.equal(toolEntry.name, 'search')
assert.equal(toolEntry.status, 'done')
assert.equal(toolEntry.output, 'result rows')

// --- session closed --------------------------------------------------------

const closed = projectConversation([ev('session_started'), ev('session_ready'), ev('session_closed')])
assert.equal(closed.sessionStatus, 'stopped')

// --- readiness copy --------------------------------------------------------

assert.equal(readinessLabel({ kind: 'ready' }), 'Ready')
assert.match(readinessLabel({ kind: 'missing-key', providerId: 'p' }), /API key/)
assert.match(readinessLabel({ kind: 'provider-unavailable', providerId: 'p' }), /not installed/)
assert.match(readinessLabel({ kind: 'model-unavailable', providerId: 'p', modelId: 'm' }), /not offered/)
assert.equal(readinessLabel({ kind: 'error', message: 'boom' }), 'boom')

// --- Stop remains available while send promise is unresolved ---------------

assert.equal(stopDisabledForPending('sending'), false, 'unresolved send does not disable Stop')
assert.equal(stopDisabledForPending('starting'), false)
assert.equal(stopDisabledForPending('stopping'), true)
assert.equal(stopDisabledForPending(null), false)

console.log('AgentChatView.test.ts: ok')
