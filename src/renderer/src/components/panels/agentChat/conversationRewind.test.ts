import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { projectConversation } from './conversationProjection'

let seq = 0
const event = (type: ConversationEventType, payload: Record<string, unknown> = {}): ConversationEvent => ({
  id: `e${++seq}`,
  seq,
  sessionId: 'conv',
  workspaceId: 'workspace',
  agentId: 'agent',
  providerId: 'claude-agent',
  modelId: 'sonnet',
  type,
  createdAt: seq,
  payload,
})

function turn(turnId: string, text: string, end: 'turn_completed' | 'turn_failed' = 'turn_completed') {
  const message = event('user_message', { turnId, text })
  return {
    seq: message.seq!,
    events: [
      message,
      event('turn_started', { turnId }),
      event('content_delta', { turnId, text: `reply to ${text}` }),
      event(end, { turnId, ...(end === 'turn_failed' ? { reason: 'provider' } : {}) }),
    ],
  }
}

const shown = (events: ConversationEvent[]) =>
  projectConversation(events).entries.map((entry) =>
    entry.kind === 'user' ? `you: ${entry.text}` : entry.kind === 'assistant' ? `agent: ${entry.text}` : entry.kind,
  )

test('a rewind takes its message and every turn after it out of view, and later turns show again', () => {
  const one = turn('t1', 'one')
  const two = turn('t2', 'two')
  const three = turn('t3', 'three')
  const rewind = event('session_updated', { rewoundFromSeq: two.seq, providerSessionId: 'native' })
  const again = turn('t4', 'two, better')
  expect(shown([...one.events, ...two.events, ...three.events, rewind, ...again.events])).toEqual([
    'you: one',
    'agent: reply to one',
    'you: two, better',
    'agent: reply to two, better',
  ])
})

test('a continuation turn inside the rewound range goes too, and a failure it hid is no longer reported', () => {
  const one = turn('t1', 'one')
  const two = turn('t2', 'two', 'turn_failed')
  const continuation = [
    event('turn_started', { turnId: 'cont_1' }),
    event('content_delta', { turnId: 'cont_1', text: 'a background agent finished' }),
    event('turn_completed', { turnId: 'cont_1' }),
  ]
  const events = [...one.events, ...two.events, ...continuation]
  expect(projectConversation(events).lastError).toBe('provider')
  const rewound = [...events, event('session_updated', { rewoundFromSeq: two.seq, providerSessionId: 'native' })]
  expect(shown(rewound)).toEqual(['you: one', 'agent: reply to one'])
  expect(projectConversation(rewound).lastError).toBeNull()
})

test('an earlier page read after the rewind is still hidden by it', () => {
  const one = turn('t1', 'one')
  const two = turn('t2', 'two')
  const rewind = event('session_updated', { rewoundFromSeq: one.seq, providerSessionId: null })
  // Pages arrive newest first; the projection folds whatever it holds, in order.
  expect(shown([rewind])).toEqual([])
  expect(shown([...one.events, ...two.events, rewind])).toEqual([])
})
