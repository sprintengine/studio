import { expect, test } from 'vitest'

import { createConversationFollower, type ConversationFollowSource } from '../src/follower.js'
import type { ConversationEvent } from '../src/protocol.js'
import type { ConversationFollowSourceFrame as ConversationStreamFrame } from '../src/follower.js'
import { checkConversationTimelineProtocol } from '../src/version.js'

const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }

function event(seq: number, type: string, payload: Record<string, unknown> = {}): ConversationEvent {
  return {
    id: `e${seq}`,
    sessionId: 's1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock-provider',
    type,
    createdAt: 1_000 + seq,
    seq,
    payload,
  } as unknown as ConversationEvent
}

function fakeSource() {
  let push: (frame: ConversationStreamFrame) => void = () => undefined
  const earlier = [event(1, 'user_message', { turnId: 't0', text: 'first' })]
  const source: ConversationFollowSource = {
    follow: (_ref, _options, onFrame) => {
      push = onFrame
      return () => undefined
    },
    loadEarlier: async () => ({ ok: true, page: { events: earlier as never, hasMore: false, beforeCursor: null } }),
  }
  return { source, push: (frame: ConversationStreamFrame) => push(frame) }
}

test('a snapshot, its fence and live events become rows, each event once', () => {
  const { source, push } = fakeSource()
  const follower = createConversationFollower(source, ref)
  let heard = 0
  follower.subscribe(() => heard++)
  push({
    type: 'snapshot',
    page: { events: [event(2, 'user_message', { turnId: 't1', text: 'hello' })], hasMore: true, beforeCursor: 2 },
  })
  push({ type: 'synchronized', seq: 2 })
  push({ type: 'event', event: event(3, 'turn_started', { turnId: 't1' }) })
  push({ type: 'event', event: event(4, 'content_delta', { turnId: 't1', text: 'Hi there' }) })
  // A resend after a reconnect is not drawn twice.
  push({ type: 'event', event: event(4, 'content_delta', { turnId: 't1', text: 'Hi there' }) })
  const state = follower.getState()
  expect(state.hydrated).toBe(true)
  expect(state.hasMore).toBe(true)
  expect(state.events.map((each) => each.seq)).toEqual([2, 3, 4])
  expect(state.rows.map((row) => row.kind)).toContain('user')
  expect(state.rows.some((row) => row.kind === 'assistant' && row.entry.text.includes('Hi there'))).toBe(true)
  expect(heard).toBeGreaterThan(0)
})

test('earlier turns are paged in before what is held', async () => {
  const { source, push } = fakeSource()
  const follower = createConversationFollower(source, ref)
  push({
    type: 'snapshot',
    page: { events: [event(2, 'user_message', { turnId: 't1', text: 'second' })], hasMore: true, beforeCursor: 2 },
  })
  await follower.loadEarlier()
  expect(follower.getState().events.map((each) => each.seq)).toEqual([1, 2])
  expect(follower.getState().hasMore).toBe(false)
})

test('a server outside the protocol window is refused, naming both', () => {
  expect(checkConversationTimelineProtocol({ protocolVersion: 1 }).ok).toBe(true)
  const refused = checkConversationTimelineProtocol({ protocolVersion: 9, minProtocolVersion: 9 })
  expect(refused.ok).toBe(false)
  expect(!refused.ok && refused.message).toMatch(/speaks conversation protocol 9; this view speaks 1/u)
})
