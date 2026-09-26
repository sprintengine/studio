import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { projectConversation } from './conversationProjection'
import { deriveConversationTimelineRows } from './conversationTimeline'
import { applyEvent, createConversationProjectionState, prependEvents } from './incrementalConversationProjection'

function event(type: ConversationEventType, index: number, payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type,
    createdAt: index * 10,
    payload,
  }
}

test('incremental projection equals the reference fold after every event', () => {
  const events = [
    event('session_started', 0, {}),
    event('user_message', 1, { turnId: 'a', text: 'Go' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('reasoning_delta', 3, { turnId: 'a', text: 'think' }),
    event('reasoning_delta', 4, { turnId: 'a', text: ' more' }),
    event('content_delta', 5, { turnId: 'a', text: 'Hello' }),
    event('content_delta', 6, { turnId: 'a', text: ' world' }),
    event('tool_started', 7, {
      turnId: 'a',
      toolUseId: 'parent',
      name: 'Task',
      kind: 'subagent',
      summary: 'Explore',
      subagentLane: true,
    }),
    event('tool_started', 8, {
      turnId: 'a',
      toolUseId: 'child',
      name: 'Read',
      kind: 'file_read',
      parentToolUseId: 'parent',
      input: { path: 'src/a.ts' },
    }),
    event('tool_output', 9, { turnId: 'a', toolUseId: 'child', output: 'sour', partial: true, status: 'ok' }),
    event('tool_output', 19, {
      turnId: 'a',
      toolUseId: 'child',
      preview: 'source',
      output: 'source',
      totalBytes: 6,
      truncated: false,
      status: 'ok',
      exitCode: 0,
    }),
    event('approval_requested', 10, { turnId: 'a', requestId: 'request', summary: 'Run command', action: 'Bash' }),
    event('approval_resolved', 11, { turnId: 'a', requestId: 'request', approved: true }),
    event('usage_updated', 12, { inputTokens: 22, outputTokens: 14 }),
    event('turn_completed', 13, { turnId: 'a', costUsd: 0.02, durationMs: 100, numTurns: 1 }),
    event('user_message', 14, { turnId: 'b', text: 'Next' }),
    event('turn_started', 15, { turnId: 'b' }),
    event('content_delta', 16, { turnId: 'b', text: 'Answer' }),
    event('tool_output', 17, {
      turnId: 'b',
      toolUseId: 'parent',
      preview: 'done',
      output: 'done',
      totalBytes: 4,
      truncated: false,
      status: 'ok',
    }),
    event('turn_failed', 18, { turnId: 'b', reason: 'failed', message: 'Oops' }),
  ]
  let state = createConversationProjectionState()
  const prefix: ConversationEvent[] = []
  for (const item of events) {
    const before = state.projection.entries
    state = applyEvent(state, item)
    prefix.push(item)
    assert.deepEqual(state.projection, projectConversation(prefix), item.type)
    if (item.type === 'content_delta' && before.length === state.projection.entries.length) {
      for (let i = 0; i < before.length; i++) {
        const entry = before[i]
        if (entry?.kind !== 'assistant' || entry.turnId !== item.payload?.turnId) {
          assert.equal(state.projection.entries[i], before[i])
        }
      }
    }
  }

  const later = events.slice(12)
  const prepended = prependEvents(createConversationProjectionState(later), events.slice(0, 12))
  assert.deepEqual(prepended.projection, projectConversation(events))
})

test('partial command output updates the running row without settling it', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('tool_started', 2, { turnId: 'a', toolUseId: 'command', name: 'Bash' }),
    event('tool_output', 3, { turnId: 'a', toolUseId: 'command', output: 'first', partial: true, status: 'ok' }),
  ]
  const partial = projectConversation(events).entries.find((entry) => entry.kind === 'tool')
  assert.equal(partial?.status, 'running')
  assert.equal(partial?.output, 'first')
  let state = createConversationProjectionState(events.slice(0, 2))
  state = applyEvent(state, events[2])
  assert.deepEqual(state.projection, projectConversation(events))
  const final = event('tool_output', 4, { turnId: 'a', toolUseId: 'command', output: 'first\nlast', status: 'ok' })
  state = applyEvent(state, final)
  assert.deepEqual(state.projection, projectConversation([...events, final]))
  const completed = state.projection.entries.find((entry) => entry.kind === 'tool')
  assert.equal(completed?.status, 'done')
  assert.equal(completed?.output, 'first\nlast')
})

test('prose before each tool remains ordered separately from the final answer', () => {
  const events = [
    event('turn_started', 1, { turnId: 'a' }),
    event('content_delta', 2, { turnId: 'a', text: 'I will inspect the file.' }),
    event('tool_started', 3, { turnId: 'a', toolUseId: 'read', name: 'Read' }),
    event('tool_started', 4, { turnId: 'a', toolUseId: 'read', name: 'Read', input: { path: 'src/a.ts' } }),
    event('tool_started', 41, { turnId: 'a', toolUseId: 'nested', name: 'Read', parentToolUseId: 'read' }),
    event('content_delta', 5, { turnId: 'a', text: 'Now I will run a check.' }),
    event('tool_started', 6, { turnId: 'a', toolUseId: 'check', name: 'Bash' }),
    event('content_delta', 7, { turnId: 'a', text: 'Everything passed.' }),
  ]
  let state = createConversationProjectionState()
  for (const item of events) state = applyEvent(state, item)
  assert.deepEqual(state.projection, projectConversation(events))
  const assistant = state.projection.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') throw new Error('Missing assistant entry')
  assert.equal(assistant?.text, 'Everything passed.')
  assert.deepEqual(assistant?.intermediateText, [
    { text: 'I will inspect the file.', beforeToolUseId: 'read' },
    { text: 'Now I will run a check.', beforeToolUseId: 'check' },
  ])
})

test('row derivation reuses objects whose entries did not change', () => {
  const events = [
    event('user_message', 1, { turnId: 'a', text: 'First' }),
    event('turn_started', 2, { turnId: 'a' }),
    event('content_delta', 3, { turnId: 'a', text: 'One' }),
    event('turn_completed', 4, { turnId: 'a' }),
    event('user_message', 5, { turnId: 'b', text: 'Second' }),
    event('turn_started', 6, { turnId: 'b' }),
    event('content_delta', 7, { turnId: 'b', text: 'Two' }),
  ]
  let state = createConversationProjectionState(events)
  const before = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn)
  state = applyEvent(state, event('content_delta', 8, { turnId: 'b', text: ' more' }))
  const after = deriveConversationTimelineRows(state.projection.entries, state.projection.activeTurn, before)
  for (let index = 0; index < before.length; index++) {
    if (before[index]?.id !== 'assistant:b') assert.equal(after[index], before[index])
  }
  assert.notEqual(
    after.find((row) => row.id === 'assistant:b'),
    before.find((row) => row.id === 'assistant:b'),
  )
})

test('checkpoint metadata and revert marks survive replay and undo', () => {
  const start = { ...event('user_message', 1, { turnId: 'a', text: 'First' }), seq: 10 }
  const second = { ...event('user_message', 4, { turnId: 'b', text: 'Second' }), seq: 20 }
  const events = [
    start,
    event('turn_started', 2, { turnId: 'a' }),
    event('turn_completed', 3, {
      turnId: 'a',
      checkpointTurnSeq: 10,
      checkpointAvailable: true,
      checkpointSummary: { files: 2, addedLines: 3, removedLines: 1 },
    }),
    second,
    event('turn_started', 5, { turnId: 'b' }),
    event('turn_completed', 6, {
      turnId: 'b',
      checkpointTurnSeq: 20,
      checkpointAvailable: true,
      checkpointSummary: { files: 1, addedLines: 1, removedLines: 0 },
    }),
    event('session_updated', 7, { revertedAfterSeq: 10, undo: false }),
  ]
  const projected = projectConversation(events)
  assert.equal(projected.revertedAfterSeq, 10)
  const firstUser = projected.entries.find((entry) => entry.kind === 'user' && entry.seq === 10)
  const firstAssistant = projected.entries.find((entry) => entry.kind === 'assistant' && entry.turnId === 'a')
  const secondUser = projected.entries.find((entry) => entry.kind === 'user' && entry.seq === 20)
  const secondAssistant = projected.entries.find((entry) => entry.kind === 'assistant' && entry.turnId === 'b')
  assert.equal(firstUser?.kind === 'user' && firstUser.reverted, true)
  assert.equal(firstAssistant?.kind === 'assistant' && firstAssistant.reverted, true)
  assert.equal(secondUser?.kind === 'user' && secondUser.reverted, true)
  assert.equal(secondAssistant?.kind === 'assistant' && secondAssistant.reverted, true)
  assert.deepEqual(
    firstAssistant?.kind === 'assistant' ? firstAssistant.checkpointSummary : undefined,
    { files: 2, addedLines: 3, removedLines: 1 },
  )
  const restored = projectConversation([...events, event('session_updated', 8, { revertedAfterSeq: 10, undo: true })])
  assert.equal(
    restored.entries.some((entry) => (entry.kind === 'user' || entry.kind === 'assistant') && entry.reverted),
    false,
  )
})

test('incremental deltas are substantially cheaper than full refolds', () => {
  const seed: ConversationEvent[] = [event('turn_started', 0, { turnId: 'a' })]
  for (let i = 1; i <= 5000; i++) seed.push(event('content_delta', i, { turnId: 'a', text: 'x' }))
  const deltas = Array.from({ length: 1000 }, (_, i) => event('content_delta', i + 5001, { turnId: 'a', text: 'y' }))
  let state = createConversationProjectionState(seed)
  let start = performance.now()
  for (const delta of deltas) state = applyEvent(state, delta)
  const incrementalMs = performance.now() - start
  const all = seed.slice()
  start = performance.now()
  for (const delta of deltas) {
    all.push(delta)
    projectConversation(all)
  }
  const foldMs = performance.now() - start
  assert.ok(foldMs >= incrementalMs * 20, `incremental ${incrementalMs.toFixed(1)}ms, fold ${foldMs.toFixed(1)}ms`)
})
