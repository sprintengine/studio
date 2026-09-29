import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../../shared/conversation-runtime'
import { MAX_TRANSCRIPT_SUMMARY_LENGTH, summarizeConversationReply } from './transcript-summary'

let seq = 0
function event(type: ConversationEventType, payload?: Record<string, unknown>): ConversationEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    seq,
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    type,
    createdAt: seq,
    ...(payload ? { payload } : {}),
  }
}

const text = (value: string) => event('content_delta', { text: value })

test('the summary is the closing message after the turn’s last tool call', () => {
  const summary = summarizeConversationReply([
    event('user_message', { text: 'review the repo' }),
    event('turn_started'),
    text("I'll read the config first."),
    event('tool_started', { toolUseId: 't1', name: 'Read' }),
    event('tool_output', { toolUseId: 't1' }),
    text('Reviewed the repo '),
    text('and filed the report.'),
    event('turn_completed'),
  ])
  assert.equal(summary, 'Reviewed the repo and filed the report.')
})

test('a subagent’s tools do not split the run agent’s message', () => {
  const summary = summarizeConversationReply([
    event('user_message', { text: 'go' }),
    text('Done: '),
    event('tool_started', { toolUseId: 's1', name: 'Grep', parentToolUseId: 'task-1' }),
    text('three files changed.'),
  ])
  assert.equal(summary, 'Done: three files changed.')
})

test('a turn that ended on a tool keeps its last words before it', () => {
  const summary = summarizeConversationReply([
    event('user_message', { text: 'go' }),
    text('Opening the pull request now.'),
    event('tool_started', { toolUseId: 't1', name: 'Bash' }),
    event('tool_output', { toolUseId: 't1' }),
    event('turn_completed'),
  ])
  assert.equal(summary, 'Opening the pull request now.')
})

test('only the last turn counts, and a turn with no words has no summary', () => {
  assert.equal(
    summarizeConversationReply([
      event('user_message', { text: 'first' }),
      text('An earlier answer.'),
      event('user_message', { text: 'second' }),
      event('tool_started', { toolUseId: 't1', name: 'Bash' }),
    ]),
    undefined,
  )
  assert.equal(summarizeConversationReply([]), undefined)
})

test('a long closing message is cut to the cap with an ellipsis', () => {
  const summary = summarizeConversationReply([text('x'.repeat(MAX_TRANSCRIPT_SUMMARY_LENGTH * 2))])!
  assert.equal(summary.length, MAX_TRANSCRIPT_SUMMARY_LENGTH)
  assert.ok(summary.endsWith('…'))
})
