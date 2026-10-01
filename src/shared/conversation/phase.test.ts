import { test } from 'vitest'
import assert from 'node:assert/strict'
import { conversationPhaseNeedsAttention, conversationPhaseOf, conversationSummaryPhase } from './phase'

test('conversation phase follows action priority', () => {
  assert.equal(conversationPhaseOf({}), 'idle')
  assert.equal(conversationPhaseOf({ completed: true }), 'completed')
  assert.equal(conversationPhaseOf({ starting: true, completed: true }), 'starting')
  assert.equal(conversationPhaseOf({ running: true, starting: true }), 'running')
  assert.equal(conversationPhaseOf({ failed: true, running: true }), 'failed')
  assert.equal(conversationPhaseOf({ inputPending: true, failed: true }), 'waiting_for_input')
  assert.equal(conversationPhaseOf({ approvalPending: true, inputPending: true }), 'waiting_for_approval')
  assert.equal(conversationPhaseNeedsAttention('running'), false)
  assert.equal(conversationPhaseNeedsAttention('waiting_for_approval'), true)
  assert.equal(conversationPhaseNeedsAttention('waiting_for_input'), true)
  assert.equal(conversationPhaseNeedsAttention('failed'), true)
  assert.equal(
    conversationSummaryPhase({
      sessionId: 'conversation-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      providerId: 'provider-1',
      modelId: 'model-1',
      status: 'active',
      phase: 'waiting_for_input',
      createdAt: 1,
      updatedAt: 2,
    }),
    'waiting_for_input',
  )
})

test('background agents keep a finished conversation working', () => {
  const summary = {
    sessionId: 'conversation-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 2,
  }
  assert.equal(conversationSummaryPhase({ ...summary, phase: 'completed', backgroundAgents: 2 }), 'running')
  assert.equal(conversationSummaryPhase({ ...summary, phase: 'idle', backgroundAgents: 1 }), 'running')
  assert.equal(conversationSummaryPhase({ ...summary, phase: 'completed' }), 'completed')
  // A person still has to answer, whatever the agents are doing.
  assert.equal(
    conversationSummaryPhase({ ...summary, phase: 'waiting_for_approval', backgroundAgents: 1 }),
    'waiting_for_approval',
  )
})
