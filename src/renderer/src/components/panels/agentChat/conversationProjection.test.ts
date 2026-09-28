import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { projectConversation, type TranscriptEntry } from './conversationProjection'
import { deriveConversationTimelineRows } from './conversationTimeline'
import { applyEvent, createConversationProjectionState } from './incrementalConversationProjection'

// `at` is the event's clock in milliseconds, so reasoning durations are exact.
function event(
  type: ConversationEventType,
  at: number,
  payload: Record<string, unknown> = {},
  modelId = 'claude-sonnet-4-5',
): ConversationEvent {
  return {
    id: `event-${at}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId,
    type,
    createdAt: at,
    payload,
  }
}

const assistantOf = (entries: TranscriptEntry[], turnId = 't1') =>
  entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> =>
      entry.kind === 'assistant' && entry.turnId === turnId,
  )

// Think → step → think again → step → think → reply, as a turn with
// interleaved reasoning streams it.
const interleaved: ConversationEvent[] = [
  event('user_message', 0, { turnId: 't1', text: 'Fix the test' }),
  event('turn_started', 1, { turnId: 't1' }),
  event('reasoning_delta', 10, { turnId: 't1', text: 'Look at the failing test first.' }),
  event('tool_started', 40, { turnId: 't1', toolUseId: 'read', name: 'Read' }),
  event('tool_output', 50, { turnId: 't1', toolUseId: 'read', output: 'ok' }),
  event('reasoning_delta', 60, { turnId: 't1', text: 'The fixture is stale.' }),
  event('content_delta', 70, { turnId: 't1', text: 'Updating the fixture.' }),
  event('reasoning_delta', 80, { turnId: 't1', text: ' Then rerun.' }),
  event('tool_started', 100, { turnId: 't1', toolUseId: 'edit', name: 'Edit' }),
  event('tool_output', 110, { turnId: 't1', toolUseId: 'edit', output: 'ok' }),
  event('reasoning_delta', 120, { turnId: 't1', text: 'Done.' }),
  event('content_delta', 150, { turnId: 't1', text: 'Fixed.' }),
  event('turn_completed', 160, { turnId: 't1' }),
]

test('reasoning keeps its place before the step it led to, with the time it streamed', () => {
  const turn = assistantOf(projectConversation(interleaved).entries)!
  expect(turn.reasoningSegments).toEqual([
    { text: 'Look at the failing test first.', beforeToolUseId: 'read', durationMs: 30 },
    // Two runs split by prose belong to the same stretch before the next step,
    // each its own paragraph.
    { text: 'The fixture is stale.\n\nThen rerun.', beforeToolUseId: 'edit', durationMs: 30 },
  ])
  expect(turn.reasoning).toBe('Done.')
  expect(turn.reasoningDurationMs).toBe(30)
  expect(turn.intermediateText).toEqual([{ text: 'Updating the fixture.', beforeToolUseId: 'edit' }])
})

test('the incremental fold places reasoning exactly as the full fold does', () => {
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of interleaved) {
    state = applyEvent(state, item)
    prefix.push(item)
    expect(state.projection).toStrictEqual(projectConversation(prefix))
  }
})

test('reasoning still streaming has no duration yet', () => {
  const turn = assistantOf(
    projectConversation([
      event('turn_started', 1, { turnId: 't1' }),
      event('reasoning_delta', 10, { turnId: 't1', text: 'Hmm' }),
    ]).entries,
  )!
  expect(turn.reasoning).toBe('Hmm')
  expect(turn.reasoningDurationMs).toBeUndefined()
})

test('a turn keeps its own token counts and the credential source it ended under', () => {
  const projection = projectConversation([
    event('session_updated', 0, { apiKeySource: 'ANTHROPIC_API_KEY' }),
    event('turn_started', 1, { turnId: 't1' }),
    event('usage_updated', 2, { turnId: 't1', inputTokens: 12_000, outputTokens: 800 }),
    event('turn_completed', 3, { turnId: 't1', costUsd: 0.12 }),
    event('turn_started', 4, { turnId: 't2' }),
    event('usage_updated', 5, { turnId: 't2', outputTokens: 20 }),
    event('turn_completed', 6, { turnId: 't2' }),
  ])
  expect(assistantOf(projection.entries)).toMatchObject({
    inputTokens: 12_000,
    outputTokens: 800,
    costUsd: 0.12,
    apiKeySource: 'ANTHROPIC_API_KEY',
  })
  const second = assistantOf(projection.entries, 't2')!
  expect(second.inputTokens).toBeUndefined()
  expect(second.outputTokens).toBe(20)
})

test('a compaction sits between its turn’s message and reply, or after the turn it followed', () => {
  const projection = projectConversation([
    event('user_message', 0, { turnId: 't1', text: 'First' }),
    event('turn_started', 1, { turnId: 't1' }),
    event('content_delta', 2, { turnId: 't1', text: 'One' }),
    event('turn_completed', 3, { turnId: 't1' }),
    event('context_compacted', 4, { trigger: 'manual', preTokens: 90_000 }),
    event('user_message', 5, { turnId: 't2', text: 'Second' }),
    event('turn_started', 6, { turnId: 't2' }),
    event('context_compacted', 7, { turnId: 't2', trigger: 'auto', preTokens: 180_000, postTokens: 20_000 }),
    event('content_delta', 8, { turnId: 't2', text: 'Two' }),
    event('turn_completed', 9, { turnId: 't2' }),
  ])
  expect(projection.entries.map((entry) => (entry.kind === 'compaction' ? entry.id : entry.kind))).toEqual([
    'user',
    'assistant',
    'event-4',
    'user',
    'event-7',
    'assistant',
  ])
  expect(projection.entries[4]).toEqual({
    kind: 'compaction',
    id: 'event-7',
    turnId: 't2',
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 20_000,
    createdAt: 7,
  })
  const rows = deriveConversationTimelineRows(projection.entries, projection.activeTurn)
  expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'compaction', 'user', 'compaction', 'assistant'])
})

test('a reply marks the model switch from the reply before it, and only then', () => {
  const turn = (id: string, at: number, modelId: string) => [
    event('user_message', at, { turnId: id, text: 'go' }, modelId),
    event('turn_started', at + 1, { turnId: id }, modelId),
    event('content_delta', at + 2, { turnId: id, text: 'done' }, modelId),
    event('turn_completed', at + 3, { turnId: id }, modelId),
  ]
  const projection = projectConversation([
    ...turn('t1', 0, 'claude-sonnet-4-5'),
    ...turn('t2', 10, 'claude-sonnet-4-5'),
    ...turn('t3', 20, 'claude-opus-4-5'),
    ...turn('t4', 30, 'claude-opus-4-5'),
  ])
  const rows = deriveConversationTimelineRows(projection.entries, projection.activeTurn)
  expect(rows.flatMap((row) => (row.kind === 'assistant' ? [row.modelSwitched ?? false] : []))).toEqual([
    false,
    false,
    true,
    false,
  ])
  // A re-derive keeps the settled rows it already had.
  const again = deriveConversationTimelineRows(projection.entries, projection.activeTurn, rows)
  expect(again.every((row, index) => row === rows[index])).toBe(true)
})
