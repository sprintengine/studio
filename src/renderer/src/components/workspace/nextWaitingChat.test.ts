import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { TerminalSessionSnapshot } from '../../../../shared/ipc/terminal'
import { chatsWaitingOnYou, nextWaitingChatId } from './nextWaitingChat'

const terminal = (workspaceId: string, extra: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot =>
  ({
    sessionId: `t-${workspaceId}`,
    kind: 'agent',
    workspaceId,
    processAlive: true,
    activity: { kind: 'idle', since: 1 },
    ...extra,
  }) as TerminalSessionSnapshot

const chat = (workspaceId: string, extra: Partial<ConversationSessionSummary>): ConversationSessionSummary => ({
  sessionId: `c-${workspaceId}`,
  workspaceId,
  agentId: 'agent-1',
  providerId: 'claude-agent',
  modelId: 'default',
  status: 'ready',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

test('blocked chats come first, then failed ones, each longest-waiting first', () => {
  const waiting = chatsWaitingOnYou({
    // The sidebar's order, which only breaks ties.
    workspaceIds: ['busy', 'failed-early', 'asked-late', 'idle', 'asked-early', 'failed-late'],
    activityByWorkspaceId: {
      busy: 'working',
      'failed-early': 'failed',
      'asked-late': 'needs-input',
      idle: 'idle',
      'asked-early': 'needs-input',
      'failed-late': 'failed',
    },
    terminalSessions: [
      terminal('asked-late', { agentState: { phase: 'awaiting_input', since: 500, source: 'hook' } }),
      terminal('failed-early', { activity: { kind: 'failed', at: 100, exitCode: 1 } }),
    ],
    conversationSessions: [
      chat('asked-early', { status: 'awaiting_approval', updatedAt: 200 }),
      chat('failed-late', { status: 'failed', lastTurnEndedAt: 900, updatedAt: 950 }),
    ],
  })
  assert.deepEqual(waiting, ['asked-early', 'asked-late', 'failed-early', 'failed-late'])
})

test('a wait with no time on it sorts after the timed ones, in sidebar order', () => {
  const waiting = chatsWaitingOnYou({
    workspaceIds: ['b', 'a', 'timed'],
    activityByWorkspaceId: { a: 'needs-input', b: 'needs-input', timed: 'needs-input' },
    terminalSessions: [terminal('timed', { agentState: { phase: 'awaiting_input', since: 5, source: 'hook' } })],
    conversationSessions: [],
  })
  assert.deepEqual(waiting, ['timed', 'b', 'a'])
})

test('one press after another visits each waiting chat and wraps round', () => {
  const waiting = ['a', 'b', 'c']
  assert.equal(nextWaitingChatId(waiting, null), 'a', 'from New chat or a door: the longest-waiting')
  assert.equal(nextWaitingChatId(waiting, 'elsewhere'), 'a', 'from a chat that is not waiting: the same')
  assert.equal(nextWaitingChatId(waiting, 'a'), 'b')
  assert.equal(nextWaitingChatId(waiting, 'b'), 'c')
  assert.equal(nextWaitingChatId(waiting, 'c'), 'a')
})

test('nothing to go to: none waiting, or only the chat on screen', () => {
  assert.equal(nextWaitingChatId([], null), null)
  assert.equal(nextWaitingChatId([], 'a'), null)
  assert.equal(nextWaitingChatId(['a'], 'a'), null)
  assert.equal(nextWaitingChatId(['a'], 'b'), 'a')
})
