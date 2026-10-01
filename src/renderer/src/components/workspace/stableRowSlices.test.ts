import { expect, test } from 'vitest'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationTabSignature, recencyEqual, stableRecord, stableSet, type RowRecency } from './stableRowSlices'

const recency = (fields: Partial<RowRecency> = {}): RowRecency => ({
  hasRunning: false,
  idleSince: null,
  lastInputAt: null,
  workingSince: null,
  ...fields,
})

test('an equal recomputation hands back the previous record and every row’s object', () => {
  const first = stableRecord({ a: recency(), b: recency({ idleSince: 5 }) }, null, recencyEqual)
  const second = stableRecord({ a: recency(), b: recency({ idleSince: 5 }) }, first, recencyEqual)
  expect(second).toBe(first)
})

test('one row moving keeps every other row’s object', () => {
  const first = stableRecord({ a: recency(), b: recency({ idleSince: 5 }) }, null, recencyEqual)
  const second = stableRecord({ a: recency(), b: recency({ idleSince: 6 }) }, first, recencyEqual)
  expect(second).not.toBe(first)
  expect(second.a).toBe(first.a)
  expect(second.b).not.toBe(first.b)
})

test('a row leaving or joining is a new record', () => {
  const first = stableRecord<string>({ a: 'idle', b: 'working' }, null)
  expect(stableRecord<string>({ a: 'idle' }, first)).not.toBe(first)
  expect(stableRecord<string>({ a: 'idle', b: 'working', c: 'idle' }, first)).not.toBe(first)
  expect(stableRecord<string>({ a: 'idle', b: 'working' }, first)).toBe(first)
})

test('a set with the same members is the previous set', () => {
  const first = stableSet(new Set(['a', 'b']), null)
  expect(stableSet(new Set(['b', 'a']), first)).toBe(first)
  expect(stableSet(new Set(['a']), first)).not.toBe(first)
})

test('the tab signature ignores what streams, and follows what a tab draws', () => {
  const chat: ConversationSessionSummary = {
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status: 'active',
    phase: 'running',
    createdAt: 1,
    updatedAt: 1,
  }
  const base = conversationTabSignature([chat])
  expect(conversationTabSignature([{ ...chat, lastAssistantText: 'More words', updatedAt: 9 }])).toBe(base)
  expect(conversationTabSignature([{ ...chat, currentToolTitle: 'Read file' }])).toBe(base)
  expect(conversationTabSignature([{ ...chat, phase: 'completed' }])).not.toBe(base)
  expect(conversationTabSignature([{ ...chat, modelId: 'opus' }])).not.toBe(base)
  expect(
    conversationTabSignature([{ ...chat, promptCache: { ttl: '1h', expiresAt: 5, recacheTokens: 60_000 } }]),
  ).not.toBe(base)
})
