import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent } from '../shared/conversation-runtime'
import { conversationSnapshotParts, type ConversationSnapshotFrame } from './conversation-stream-shaping'

// A snapshot's events are measured once each, however many subscribers join
// the same chat: every snapshot of it holds the same event objects.

function counted(seq: number, text: string): { event: ConversationEvent; reads: () => number } {
  let reads = 0
  const event = {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    type: 'content_delta',
    createdAt: seq,
    payload: { text },
  } as unknown as ConversationEvent
  // Counts each time the event is turned into JSON, and is otherwise invisible.
  Object.defineProperty(event, 'toJSON', {
    enumerable: false,
    value(this: ConversationEvent) {
      reads++
      const { ...plain } = this
      return plain
    },
  })
  return { event, reads: () => reads }
}

const snapshot = (events: ConversationEvent[]): ConversationSnapshotFrame =>
  ({
    type: 'snapshot',
    page: { events, hasMore: false, beforeCursor: null },
  }) as unknown as ConversationSnapshotFrame

test('a snapshot measures each event once, for every subscriber after the first', () => {
  const a = counted(1, 'hello')
  const b = counted(2, 'world')
  const events = [a.event, b.event]
  const first = conversationSnapshotParts(snapshot(events), (part) => part)
  const second = conversationSnapshotParts(snapshot(events), (part) => part)
  assert.equal(first.bytes, second.bytes)
  assert.ok(first.bytes > 0)
  assert.deepEqual([a.reads(), b.reads()], [1, 1])
})

test('a merged run that grew in place, with its seq moved, is measured again', () => {
  const run = counted(3, 'part')
  const before = conversationSnapshotParts(snapshot([run.event]), (part) => part).bytes
  ;(run.event.payload as { text: string }).text = 'part, and more of it'
  ;(run.event as { seq: number }).seq = 4
  const after = conversationSnapshotParts(snapshot([run.event]), (part) => part).bytes
  assert.ok(after > before)
  assert.equal(run.reads(), 2)
})
