import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation } from '../src/conversationProjection.js'
import { compactTokenRuns, SeqRanges } from '../src/sessionEventLog.js'

test('sequence ranges hold what was seen, however it arrived', () => {
  const ranges = new SeqRanges()
  for (let seq = 100; seq <= 5000; seq++) ranges.add(seq)
  assert.equal(ranges.rangeCount, 1)
  for (const seq of [10, 12, 11, 50, 99]) ranges.add(seq)
  assert.equal(ranges.rangeCount, 3)
  for (const seq of [10, 11, 12, 50, 99, 100, 2500, 5000]) assert.ok(ranges.has(seq), String(seq))
  for (const seq of [9, 13, 49, 51, 98, 5001]) assert.ok(!ranges.has(seq), String(seq))
  for (let seq = 13; seq < 99; seq++) ranges.add(seq)
  assert.equal(ranges.rangeCount, 1)
  ranges.clear()
  assert.ok(!ranges.has(100))
})

let counter = 0
function event(type: ConversationEventType, payload: Record<string, unknown>, extra: Partial<ConversationEvent> = {}) {
  counter++
  return {
    id: `event-${counter}`,
    seq: counter,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type,
    createdAt: counter * 10,
    payload,
    ...extra,
  } as ConversationEvent
}

test('merging runs of tokens folds to the same transcript', () => {
  const events = [
    event('user_message', { turnId: 'a', text: 'Go' }),
    event('turn_started', { turnId: 'a' }),
    event('reasoning_delta', { turnId: 'a', text: 'First' }),
    event('reasoning_delta', { turnId: 'a', text: ' thought.' }),
    event('content_delta', { turnId: 'a', text: 'Prose ' }),
    event('content_delta', { turnId: 'a', delta: 'via delta ' }),
    event('content_delta', { turnId: 'a', text: '' }),
    event('content_delta', { turnId: 'a', text: 'end.' }),
    // A new stretch of thinking whose first token is whitespace: trimmed on
    // its own, so it stays its own event.
    event('reasoning_delta', { turnId: 'a', text: '  ' }),
    event('reasoning_delta', { turnId: 'a', text: ' second' }),
    event('reasoning_delta', { turnId: 'a', text: ' thought' }),
    event('tool_started', { turnId: 'a', toolUseId: 't', name: 'Read' }),
    event('content_delta', { turnId: 'a', text: 'After ' }),
    // Another turn between two tokens ends the run.
    event('content_delta', { turnId: 'b', text: 'other turn' }),
    event('content_delta', { turnId: 'a', text: 'the tool.' }),
    // A token carrying a notice is left alone.
    event('content_delta', { turnId: 'a', text: ' noted', notice: 'Checkpoints are off.' }),
    event('content_delta', { turnId: 'a', text: ' more' }),
    event('content_delta', { turnId: 'a', text: ' text' }),
    event('turn_completed', { turnId: 'a' }),
  ]
  const compacted = compactTokenRuns(events)
  assert.ok(compacted.length < events.length)
  assert.deepEqual(projectConversation(compacted), projectConversation(events))
  // A merged run keeps its first time and id, and its last number.
  const merged = compacted.find((item) => item.payload?.text === 'Prose via delta end.')
  assert.equal(merged?.createdAt, events[4]!.createdAt)
  assert.equal(merged?.id, events[4]!.id)
  assert.equal(merged?.seq, events[7]!.seq)
  // Nothing to merge is the same array; a start index leaves what is before it.
  assert.equal(compactTokenRuns(compacted), compacted)
  assert.deepEqual(compactTokenRuns(events, 5).slice(0, 5), events.slice(0, 5))
})
