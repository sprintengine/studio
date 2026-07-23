import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ConversationEvent, ConversationEventType } from '../../../../shared/conversation-runtime'
import {
  activeConversationStage,
  deriveConversationTimelineRows,
  flattenToolEntries,
  formatStepDuration,
  isAuthShapedFailure,
  isConversationBusy,
  isConversationModelLocked,
  parseOptionLabel,
  projectConversation,
  readinessLabel,
  stopDisabledForPending,
  subagentLaneLabel,
  toolObject,
  toolVerb,
  WorkTimeline,
  type ConversationTimelineRow,
  type TranscriptEntry,
  type TranscriptToolEntry,
} from './AgentChatView'

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

function row<T extends ConversationTimelineRow['kind']>(rows: ConversationTimelineRow[], kind: T) {
  const found = rows.find((entry) => entry.kind === kind)
  assert.ok(found, `timeline row for ${kind}`)
  return found as Extract<ConversationTimelineRow, { kind: T }>
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
assert.equal(activeConversationStage(streaming.entries, streaming.activeTurn), 'responding')
// user turn renders before its assistant turn
assert.equal(streaming.entries[0]?.kind, 'user')
assert.equal(streaming.entries[1]?.kind, 'assistant')
const streamingRows = deriveConversationTimelineRows(streaming.entries, streaming.activeTurn)
assert.equal(streamingRows.filter((entry) => entry.kind === 'working').length, 1, 'streaming has one live state row')

const thinkingOnly = projectConversation([ev('turn_started', { turnId: T1 })])
assert.equal(activeConversationStage(thinkingOnly.entries, thinkingOnly.activeTurn), 'thinking')
const thinkingRows = deriveConversationTimelineRows(thinkingOnly.entries, thinkingOnly.activeTurn)
assert.equal(row(thinkingRows, 'working').label, 'Thinking…')

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
assert.equal(activeConversationStage(pendingApproval.entries, pendingApproval.activeTurn), 'approval')
const pendingEntry = pendingApproval.entries.find((e) => e.kind === 'approval')
assert.ok(pendingEntry && pendingEntry.kind === 'approval' && pendingEntry.status === 'pending')
const pendingApprovalRows = deriveConversationTimelineRows(pendingApproval.entries, pendingApproval.activeTurn)
assert.equal(pendingApprovalRows.some((entry) => entry.kind === 'approval'), false, 'pending approval is owned by the composer dock')
assert.equal(pendingApprovalRows.some((entry) => entry.kind === 'working'), false, 'pending approval suppresses duplicate working row')

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
  ev('tool_started', { turnId: T1, callId: 'c2', name: 'read_file' }),
  ev('tool_output', { turnId: T1, callId: 'c1', output: 'result rows' }),
  ev('tool_output', { turnId: T1, callId: 'c2', output: 'file body' }),
  ev('turn_completed', { turnId: T1 }),
])
const toolEntry = withTool.entries.find((e) => e.kind === 'tool')
assert.ok(toolEntry && toolEntry.kind === 'tool')
assert.equal(toolEntry.name, 'search')
assert.equal(toolEntry.status, 'done')
assert.equal(toolEntry.output, 'result rows')
const toolRows = deriveConversationTimelineRows(withTool.entries, withTool.activeTurn)
const toolTurnRow = row(toolRows, 'assistant')
assert.equal(toolTurnRow.tools.length, 2, 'consecutive tool calls are grouped onto the turn row')
assert.equal(toolTurnRow.entry.text, '', 'tool-only turn still renders its work timeline')

// Tool steps carry timestamps so the timeline can show per-step durations.
const [firstTool, secondTool] = toolTurnRow.tools
assert.ok(firstTool && typeof firstTool.startedAt === 'number', 'tool start timestamp recorded')
assert.ok(firstTool && typeof firstTool.completedAt === 'number' && firstTool.completedAt > (firstTool.startedAt ?? 0))
assert.ok(secondTool && typeof secondTool.completedAt === 'number')

const runningTool = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('tool_started', { turnId: T1, callId: 'c1', name: 'search' }),
])
assert.equal(activeConversationStage(runningTool.entries, runningTool.activeTurn), 'tool')
assert.equal(
  row(deriveConversationTimelineRows(runningTool.entries, runningTool.activeTurn), 'working').label,
  'Calling search…',
)

// --- reasoning rides the turn row, separate from prose ---------------------

const withReasoning = projectConversation([
  ev('turn_started', { turnId: T1 }),
  ev('reasoning_delta', { turnId: T1, text: 'Checking repo docs.' }),
  ev('content_delta', { turnId: T1, text: 'Found the brand guide.' }),
  ev('turn_completed', { turnId: T1 }),
])
const reasoningRow = row(deriveConversationTimelineRows(withReasoning.entries, withReasoning.activeTurn), 'assistant')
assert.equal(reasoningRow.entry.reasoning, 'Checking repo docs.')
assert.equal(reasoningRow.entry.text, 'Found the brand guide.')
// Reasoning window: first reasoning_delta -> first non-reasoning event.
assert.ok(
  typeof reasoningRow.entry.reasoningDurationMs === 'number' && reasoningRow.entry.reasoningDurationMs > 0,
  'reasoning duration derives from event timestamps',
)

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

// --- Send-while-busy queues instead of erroring (D6/1776) -------------------

// Idle: a live send is allowed.
assert.equal(isConversationBusy(false, false, null), false, 'idle session accepts a live send')
// Streaming: the runtime guard would reject a new turn, so the submit queues.
assert.equal(isConversationBusy(true, false, null), true, 'streaming turn queues the next message')
// Awaiting approval queues too (pendingRequestId is set on the runtime).
assert.equal(isConversationBusy(false, true, null), true, 'awaiting approval queues the next message')
// An in-flight send (before the turn events land) also queues, so a fast second
// Enter never fires two overlapping sends.
assert.equal(isConversationBusy(false, false, 'sending'), true, 'in-flight send queues the next message')
assert.equal(isConversationBusy(false, false, 'starting'), true)

// --- Model picker locks once the conversation has started ------------------

assert.equal(isConversationModelLocked(0, null), false, 'model is editable before the first turn with no session')
assert.equal(isConversationModelLocked(1, null), true, 'model locks after the first user turn')
assert.equal(isConversationModelLocked(0, 'session-1'), true, 'model locks once a session exists')
// After an app restart userTurns/sessionId are empty local state, but replayed
// history means the conversation has started: the pill must stay locked.
assert.equal(isConversationModelLocked(0, null, true), true, 'replayed transcript history locks the model')

// --- Tool rows carry the provider's input summary ---------------------------

const toolSummaryProjection = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: 'turn-tool' }),
    ev('tool_started', { turnId: 'turn-tool', toolCallId: 'tu-1', tool: 'Bash', summary: 'Bash: npm test' }),
    ev('tool_output', { turnId: 'turn-tool', toolCallId: 'tu-1', output: '2 passing' }),
    ev('turn_completed', { turnId: 'turn-tool' }),
  ],
  [{ id: 'u-t', text: 'run the tests' }],
)
const summarizedToolEntry = toolSummaryProjection.entries.find(
  (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool',
)
assert.equal(summarizedToolEntry?.name, 'Bash')
assert.equal(summarizedToolEntry?.summary, 'Bash: npm test')
assert.equal(summarizedToolEntry?.output, '2 passing')
assert.equal(summarizedToolEntry?.status, 'done')

// --- Structured question card (approval kind: question) --------------------

const TQ = 'turn-q'
const questionPayload = {
  turnId: TQ,
  requestId: 'req-q',
  action: 'AskUserQuestion',
  kind: 'question',
  summary: 'Which auth method?',
  questions: [
    {
      question: 'Which auth method?',
      header: 'Auth',
      multiSelect: false,
      allowFreeText: true,
      options: [
        { label: 'OAuth', description: 'Redirect flow' },
        { label: 'API key' },
      ],
    },
  ],
}
const questionPending = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: TQ }),
    ev('approval_requested', questionPayload),
  ],
  [{ id: 'u-q', text: 'help me pick' }],
)
assert.equal(questionPending.awaitingApproval, true)
const pendingQuestionEntry = questionPending.entries.find(
  (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
)
assert.ok(pendingQuestionEntry)
assert.equal(pendingQuestionEntry.requestKind, 'question')
assert.equal(pendingQuestionEntry.questions?.length, 1)
assert.equal(pendingQuestionEntry.questions?.[0]?.options.length, 2)
assert.equal(pendingQuestionEntry.questions?.[0]?.options[0]?.label, 'OAuth')
assert.equal(pendingQuestionEntry.status, 'pending')

const questionResolved = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: TQ }),
    ev('approval_requested', questionPayload),
    ev('approval_resolved', { turnId: TQ, requestId: 'req-q', approved: true, answers: { 'Which auth method?': 'OAuth' } }),
    ev('content_delta', { turnId: TQ, text: 'Using OAuth then.' }),
    ev('turn_completed', { turnId: TQ }),
  ],
  [{ id: 'u-q', text: 'help me pick' }],
)
assert.equal(questionResolved.awaitingApproval, false)
const resolvedQuestionEntry = questionResolved.entries.find(
  (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
)
assert.equal(resolvedQuestionEntry?.status, 'approved')
assert.deepEqual(resolvedQuestionEntry?.answers, { 'Which auth method?': 'OAuth' })

// --- Plan approval card (approval kind: plan) -------------------------------

const planProjection = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('turn_started', { turnId: 'turn-p' }),
    ev('approval_requested', {
      turnId: 'turn-p',
      requestId: 'req-p',
      action: 'ExitPlanMode',
      kind: 'plan',
      summary: 'The agent proposed a plan.',
      plan: '## Plan\n1. Step one',
    }),
  ],
  [{ id: 'u-p', text: 'plan it' }],
)
const planEntry = planProjection.entries.find(
  (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
)
assert.equal(planEntry?.requestKind, 'plan')
assert.equal(planEntry?.plan, '## Plan\n1. Step one')

// --- Persisted user_message events drive user bubbles (replay) --------------

const replayProjection = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('user_message', { turnId: 'turn-r1', text: 'first question', localTurnId: 'local-1' }),
    ev('turn_started', { turnId: 'turn-r1' }),
    ev('content_delta', { turnId: 'turn-r1', text: 'first answer' }),
    ev('turn_completed', { turnId: 'turn-r1' }),
  ],
  // Locals are empty after a reload: user bubbles must come from events.
  [],
)
const replayUsers = replayProjection.entries.filter((entry) => entry.kind === 'user')
assert.equal(replayUsers.length, 1)
assert.equal(replayUsers[0]?.kind === 'user' && replayUsers[0].text, 'first question')

// Live path: the represented local is not duplicated; a brand-new optimistic
// local (no user_message yet) still renders at the tail.
const optimisticProjection = projectConversation(
  [
    ev('session_started'),
    ev('session_ready'),
    ev('user_message', { turnId: 'turn-r1', text: 'first question', localTurnId: 'local-1' }),
    ev('turn_started', { turnId: 'turn-r1' }),
    ev('turn_completed', { turnId: 'turn-r1' }),
  ],
  [
    { id: 'local-1', text: 'first question' },
    { id: 'local-2', text: 'second question in flight' },
  ],
)
const optimisticUsers = optimisticProjection.entries.filter((entry) => entry.kind === 'user')
assert.equal(optimisticUsers.length, 2)
assert.equal(optimisticUsers[1]?.kind === 'user' && optimisticUsers[1].text, 'second question in flight')

// --- work-timeline vocabulary (pure helpers) ---------------------------------

assert.equal(toolVerb('Read', false), 'Read')
assert.equal(toolVerb('Grep', false), 'Searched')
assert.equal(toolVerb('Edit', false), 'Edited')
assert.equal(toolVerb('Edit', true), 'Editing')
assert.equal(toolVerb('Bash', false), 'Ran')
assert.equal(toolVerb('Bash', true), 'Running')
assert.equal(toolVerb('CustomTool', false), 'Called CustomTool')
assert.equal(toolVerb('CustomTool', true), 'Calling CustomTool')

assert.equal(toolObject({ name: 'Bash', summary: 'Bash: npm test' }), 'npm test', 'summary prefix strips to the object')
assert.equal(toolObject({ name: 'Bash', summary: 'plain summary' }), 'plain summary')
assert.equal(toolObject({ name: 'Bash' }), '')

assert.deepEqual(parseOptionLabel('OAuth (Recommended)'), { text: 'OAuth', recommended: true })
assert.deepEqual(parseOptionLabel('OAuth (recommended)'), { text: 'OAuth', recommended: true })
assert.deepEqual(parseOptionLabel('API keys'), { text: 'API keys', recommended: false })

assert.equal(formatStepDuration(200), '0.2s')
assert.equal(formatStepDuration(3000), '3s')
assert.equal(formatStepDuration(21_000), '21s')
assert.equal(formatStepDuration(83_000), '1m 23s')

assert.equal(isAuthShapedFailure('OAuth token expired. Run `claude login`.'), true)
assert.equal(isAuthShapedFailure('HTTP 401 from provider'), true)
assert.equal(isAuthShapedFailure('network timeout'), false)
assert.equal(isAuthShapedFailure(undefined), false)

// --- diff chips + permission action + failure detail ride the projection ----

const richTurn = projectConversation([
  ev('turn_started', { turnId: 'turn-rich' }),
  ev('tool_started', { turnId: 'turn-rich', toolCallId: 'e1', tool: 'Edit', summary: 'Edit: src/sync/worker.ts', addedLines: 34, removedLines: 6 }),
  ev('tool_output', { turnId: 'turn-rich', toolCallId: 'e1', output: 'ok' }),
  ev('approval_requested', { turnId: 'turn-rich', requestId: 'req-b', action: 'Bash', kind: 'tool', summary: 'Bash: git rm stale.ts' }),
  ev('approval_resolved', { turnId: 'turn-rich', requestId: 'req-b', approved: true }),
  ev('turn_failed', { turnId: 'turn-rich', reason: 'provider', message: 'exit 1 · OAuth token expired' }),
])
const richTool = richTurn.entries.find((entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool')
assert.equal(richTool?.addedLines, 34)
assert.equal(richTool?.removedLines, 6)
const richApproval = richTurn.entries.find((entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval')
assert.equal(richApproval?.action, 'Bash', 'the tool behind a permission request is preserved')
const richAssistant = assistant(richTurn.entries, 'turn-rich')
assert.equal(richAssistant.failureReason, 'provider')
assert.equal(richAssistant.failureDetail, 'exit 1 · OAuth token expired', 'full provider message kept for Show details')

// --- turn byline: modelId is captured from the turn's events -----------------

const modelTurnEvents: ConversationEvent[] = [
  { ...ev('turn_started', { turnId: 'turn-m' }), modelId: 'sonnet' },
  ev('content_delta', { turnId: 'turn-m', text: 'hi' }),
  ev('turn_completed', { turnId: 'turn-m' }),
]
assert.equal(assistant(projectConversation(modelTurnEvents).entries, 'turn-m').modelId, 'sonnet')

// --- apiKeySource rides session_updated (subscription-auth guarantee) -------

assert.equal(empty.apiKeySource, null, 'no session_updated means no reported auth source')

const subscriptionAuth = projectConversation([
  ev('session_started'),
  ev('session_ready'),
  ev('session_updated', { providerSessionId: 'cli-1', apiKeySource: 'none' }),
])
assert.equal(subscriptionAuth.apiKeySource, 'none')

const apiKeyAuth = projectConversation([
  ev('session_started'),
  ev('session_ready'),
  // A cursor-only update (no auth info) must not erase a later init's source.
  ev('session_updated', { providerSessionId: 'cli-1' }),
  ev('session_updated', { providerSessionId: 'cli-1', apiKeySource: 'ANTHROPIC_API_KEY' }),
  ev('session_updated', { providerSessionId: 'cli-2' }),
])
assert.equal(apiKeyAuth.apiKeySource, 'ANTHROPIC_API_KEY', 'latest reported source wins; cursor-only updates keep it')

// --- subagent lanes: parent-linked tool events nest under their Task lane ---

const LANE_TURN = 'turn-lane'
const fanOutEvents: ConversationEvent[] = [
  ev('turn_started', { turnId: LANE_TURN }),
  ev('tool_started', { turnId: LANE_TURN, toolCallId: 'lane-a', tool: 'Task', summary: 'Task: map the reducer', subagentLane: true, subagentType: 'Explore' }),
  ev('tool_started', { turnId: LANE_TURN, toolCallId: 'lane-b', tool: 'Task', summary: 'Task: audit the IPC', subagentLane: true, subagentType: 'general-purpose' }),
  ev('tool_started', { turnId: LANE_TURN, toolCallId: 'a1', tool: 'Read', summary: 'Read: src/a.ts', parentToolUseId: 'lane-a' }),
  ev('tool_started', { turnId: LANE_TURN, toolCallId: 'b1', tool: 'Grep', summary: 'Grep: conversation', parentToolUseId: 'lane-b' }),
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'a1', output: 'file body', parentToolUseId: 'lane-a' }),
  ev('tool_started', { turnId: LANE_TURN, toolCallId: 'top-1', tool: 'Bash', summary: 'Bash: npm test' }),
]
const fanOut = projectConversation(fanOutEvents)
const laneTools = fanOut.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
assert.deepEqual(
  laneTools.map((tool) => tool.id),
  ['lane-a', 'lane-b', 'top-1'],
  'child tool calls leave the top level and nest under their lane'
)
const laneA = laneTools[0]
assert.equal(laneA?.subagentLane, true)
assert.equal(laneA?.subagentType, 'Explore')
assert.equal(laneA?.status, 'running', 'a lane stays running until its own tool_output arrives')
assert.deepEqual(laneA?.children?.map((child) => child.id), ['a1'])
assert.equal(laneA?.children?.[0]?.status, 'done', 'a child closes on its own parent-linked output')
assert.deepEqual(laneTools[1]?.children?.map((child) => child.id), ['b1'])
assert.equal(laneTools[2]?.subagentLane, undefined, 'ordinary top-level tools are untouched')
assert.equal(flattenToolEntries(laneTools).length, 5, 'lane children count as real steps')
assert.equal(subagentLaneLabel(laneA as TranscriptToolEntry), 'Explore agent')
assert.equal(subagentLaneLabel(laneTools[1] as TranscriptToolEntry), 'general-purpose agent')

// Two lanes running at once are reported as a fan-out, not as the last tool.
const fanOutRows = deriveConversationTimelineRows(fanOut.entries, fanOut.activeTurn)
assert.equal(row(fanOutRows, 'working').label, '2 agents working…')
assert.equal(row(fanOutRows, 'assistant').tools.length, 3, 'the turn row carries lanes, not flattened children')

// One lane closed: the other still names itself, and the closed lane keeps its
// real duration (start → its own output), not a child's stamp.
const laneClosed = projectConversation([
  ...fanOutEvents,
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-b', output: 'audit done' }),
])
const closedLaneRows = deriveConversationTimelineRows(laneClosed.entries, laneClosed.activeTurn)
assert.equal(row(closedLaneRows, 'working').label, 'Explore agent working…')
const closedLane = laneClosed.entries.find(
  (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.id === 'lane-b'
)
assert.equal(closedLane?.status, 'done')
assert.ok(
  closedLane?.startedAt !== undefined
    && closedLane.completedAt !== undefined
    && closedLane.completedAt > closedLane.startedAt,
  'a lane spans from its spawn to its own completion'
)

// A lane without a subagentLane flag is still a lane once children link to it,
// and a child whose parent never arrived stays visible at the top level.
const impliedLane = projectConversation([
  ev('turn_started', { turnId: 'turn-implied' }),
  ev('tool_started', { turnId: 'turn-implied', toolCallId: 'p1', tool: 'Task', summary: 'Task: investigate' }),
  ev('tool_started', { turnId: 'turn-implied', toolCallId: 'p1c', tool: 'Read', summary: 'Read: src/x.ts', parentToolUseId: 'p1' }),
  ev('tool_started', { turnId: 'turn-implied', toolCallId: 'orphan', tool: 'Read', summary: 'Read: src/y.ts', parentToolUseId: 'missing' }),
])
const impliedTools = impliedLane.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
assert.deepEqual(impliedTools.map((tool) => tool.id), ['p1', 'orphan'])
assert.equal(impliedTools[0]?.subagentLane, true, 'having children is enough to be a lane')
assert.equal(subagentLaneLabel(impliedTools[0] as TranscriptToolEntry), 'Agent', 'an untyped lane falls back to the generic noun')
assert.equal(toolObject(impliedTools[0] as TranscriptToolEntry), 'investigate', 'the spawn summary is the lane object')
assert.equal(impliedTools[1]?.children, undefined, 'an orphaned child renders rather than disappearing')

// A subagent that reports after its turn's result rides the continuation turn
// (`<sessionId>_cont_<n>`): its calls, and the lane's own closing output, carry
// a different turnId than the Task call that spawned them. They still belong to
// that lane, and must not close some unrelated call on the continuation turn.
const continuationFanOut = projectConversation([
  ev('turn_started', { turnId: 'turn-parent' }),
  ev('tool_started', { turnId: 'turn-parent', toolCallId: 'lane-x', tool: 'Task', summary: 'Task: dig', subagentLane: true, subagentType: 'Explore' }),
  ev('turn_completed', { turnId: 'turn-parent' }),
  ev('turn_started', { turnId: 'turn-parent_cont_1' }),
  ev('tool_started', { turnId: 'turn-parent_cont_1', toolCallId: 'sib-1', tool: 'Bash', summary: 'Bash: npm test' }),
  ev('tool_started', { turnId: 'turn-parent_cont_1', toolCallId: 'x1', tool: 'Read', summary: 'Read: src/deep.ts', parentToolUseId: 'lane-x' }),
  ev('tool_output', { turnId: 'turn-parent_cont_1', toolCallId: 'lane-x', output: 'dug' }),
])
const continuationTools = continuationFanOut.entries.filter(
  (entry): entry is TranscriptToolEntry => entry.kind === 'tool'
)
assert.deepEqual(
  continuationTools.map((tool) => tool.id),
  ['lane-x', 'sib-1'],
  'a continuation-turn child joins its lane instead of becoming a stray row'
)
assert.deepEqual(continuationTools[0]?.children?.map((child) => child.id), ['x1'])
assert.equal(continuationTools[0]?.status, 'done', 'a lane closes on the continuation turn that carries its result')
assert.equal(continuationTools[1]?.status, 'running', 'the lane result never closes an unrelated continuation call')

// Output without a call id closes the latest call in its own lane only.
const idlessOutput = projectConversation([
  ev('turn_started', { turnId: 'turn-idless' }),
  ev('tool_started', { turnId: 'turn-idless', toolCallId: 'lane-c', tool: 'Task', summary: 'Task: check', subagentLane: true }),
  ev('tool_started', { turnId: 'turn-idless', toolCallId: 'c1', tool: 'Read', summary: 'Read: src/z.ts', parentToolUseId: 'lane-c' }),
  ev('tool_output', { turnId: 'turn-idless', output: 'child done', parentToolUseId: 'lane-c' }),
])
const idlessLane = idlessOutput.entries.find(
  (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.id === 'lane-c'
)
assert.equal(idlessLane?.status, 'running', 'a child output never closes its parent lane')
assert.equal(idlessLane?.children?.[0]?.status, 'done')

// --- the work timeline renders lanes as live rows, children nested ---------

const laneMarkup = renderToStaticMarkup(
  createElement(WorkTimeline, { tools: laneTools, live: true })
)
assert.ok(laneMarkup.includes('Explore agent'), 'a running lane names the agent that was spawned')
assert.ok(laneMarkup.includes('general-purpose agent'), 'concurrent lanes both render')
assert.ok(laneMarkup.includes('map the reducer'), 'a lane says what its agent was sent to do')
assert.ok(laneMarkup.includes('audit the IPC'), 'same-type lanes stay distinguishable by their task')
assert.ok(laneMarkup.includes('src/a.ts'), 'a live lane shows the steps running inside it')
assert.equal(
  (laneMarkup.match(/aria-expanded="true"/g) ?? []).length,
  3,
  'the turn timeline and both live lanes mount expanded'
)
assert.ok(laneMarkup.includes('Working'), 'the turn header stays live while lanes run')
assert.equal((laneMarkup.match(/>running</g) ?? []).length, 4, 'running lanes and steps carry an accessible status')

// The same fan-out, finished: the turn counts every step including the ones
// that ran inside the lanes, and replayed lanes mount collapsed.
const finishedFanOut = projectConversation([
  ...fanOutEvents,
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'b1', output: 'hits', parentToolUseId: 'lane-b' }),
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-a', output: 'mapped' }),
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-b', output: 'audited' }),
  ev('tool_output', { turnId: LANE_TURN, toolCallId: 'top-1', output: '2 passing' }),
  ev('turn_completed', { turnId: LANE_TURN }),
])
const doneLaneMarkup = renderToStaticMarkup(
  createElement(WorkTimeline, {
    tools: finishedFanOut.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool'),
    live: false,
  })
)
assert.ok(doneLaneMarkup.includes('5 steps'), 'the turn header counts lane children as real steps')
assert.ok(doneLaneMarkup.includes('general-purpose agent'), 'a finished lane keeps its identity')
assert.ok(!doneLaneMarkup.includes('src/a.ts'), 'a finished lane replayed from history mounts collapsed')
assert.ok(!doneLaneMarkup.includes('>running<'), 'nothing claims to be running once the fan-out is done')

console.log('AgentChatView.test.ts: ok')
