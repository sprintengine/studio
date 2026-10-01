import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent as AppConversationEvent } from '../../../src/shared/conversation-runtime'
import { CONVERSATION_EVENT_TYPES, isConversationEventType, type ConversationEvent } from '../src/events'
import { parseConversationServerFrame, parseConversationWireEvent } from '../src/serverFrames'

const event = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `evt-${type}`,
  seq: 7,
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: 'claude-agent',
  modelId: 'default',
  type,
  createdAt: 1_700_000_000_000,
  ...extra,
})

test('the desktop’s event type is the protocol’s, not a copy of it', () => {
  // Both directions compile only while the two are one declaration.
  const fromApp: ConversationEvent = event('turn_started') as AppConversationEvent
  const toApp: AppConversationEvent = fromApp
  assert.equal(toApp.type, 'turn_started')
})

test('every event type the protocol defines passes the client’s envelope check', () => {
  for (const type of CONVERSATION_EVENT_TYPES) {
    assert.equal(isConversationEventType(type), true, type)
    assert.equal(parseConversationWireEvent(event(type))?.type, type, type)
  }
  assert.equal(new Set(CONVERSATION_EVENT_TYPES).size, CONVERSATION_EVENT_TYPES.length)
})

test('an event type from a newer desktop is passed on as an envelope, not refused', () => {
  // A client skips a kind it does not know; refusing the frame would stall its cursor.
  assert.equal(isConversationEventType('plan_proposed'), false)
  assert.equal(parseConversationWireEvent(event('plan_proposed'))?.type, 'plan_proposed')
})

test('an event survives the wire as it was recorded', () => {
  const recorded = event('approval_requested', {
    payload: { requestId: 'req-1', kind: 'plan', plan: 'Rename the module.', summary: 'The agent proposed a plan.' },
  })
  const parsed = parseConversationServerFrame(JSON.parse(JSON.stringify({ type: 'event', event: recorded })))
  assert.deepEqual(parsed, { type: 'event', event: recorded })
})
