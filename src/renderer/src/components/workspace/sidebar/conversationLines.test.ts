import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { combinedAgentActivity, conversationLineMark, conversationLineText } from './conversationLines'

const session = (
  status: ConversationSessionSummary['status'],
  lastAssistantText?: string,
): ConversationSessionSummary => ({
  sessionId: 'conversation-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  providerId: 'provider-1',
  modelId: 'model-1',
  status,
  createdAt: 1,
  updatedAt: 2,
  lastAssistantText,
})

test('conversation lines use the sidebar status idiom', () => {
  assert.equal(conversationLineText(session('awaiting_approval')), 'Needs approval')
  assert.equal(conversationLineText(session('active')), 'Thinking')
  assert.equal(conversationLineText({ ...session('active'), currentToolTitle: 'Reading files' }), 'Reading files')
  assert.equal(conversationLineText(session('failed')), 'Failed')
  assert.equal(conversationLineText(session('ready', 'The checks pass.')), 'The checks pass.')
  assert.equal(combinedAgentActivity('working', [session('awaiting_approval')]), 'needs-input')
  assert.equal(combinedAgentActivity('idle', [session('active')]), 'working')
  assert.equal(combinedAgentActivity('failed', [session('ready')]), 'failed')
})

test('a chat line names the CLI it rides, the way a terminal line does', () => {
  const claude = conversationLineMark({ providerId: 'claude-agent', modelId: 'default', displayName: 'Mara Quill' })
  assert.equal(claude.cli, 'claude-code')
  assert.equal(claude.runtimeLabel, 'Claude Code chat')
  assert.equal(claude.tooltip, 'Mara Quill · Claude Code chat · default')
  assert.equal(conversationLineMark({ providerId: 'codex-agent', modelId: 'gpt-5' }).cli, 'codex')
  const api = conversationLineMark({ providerId: 'openai-compatible-api', modelId: 'model-1' })
  assert.equal(api.cli, null)
  assert.equal(api.tooltip, 'Chat · model-1')
})
