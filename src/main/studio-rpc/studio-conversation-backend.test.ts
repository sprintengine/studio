import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { createStudioConversationBackend } from './studio-conversation-backend'

const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' }
const session = (extra: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary => ({
  sessionId: 's-1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: 'claude-agent',
  modelId: 'default',
  status: 'ready',
  createdAt: 1,
  updatedAt: 1,
  permissionPreset: 'manual',
  ...extra,
})

function backend(sessions: ConversationSessionSummary[]) {
  return createStudioConversationBackend({
    host: { permissionOf: () => 'manual' } as never,
    launch: async () => ({ ok: false, code: 'unused', message: 'unused' }),
    listSessions: () => ({ ok: true, sessions }),
    stopSession: async () => ({ ok: true, session: session({ status: 'stopped' }) }),
    getWorkspaceAgents: () => [],
  })
}

test('a chat whose session may use tools unasked counts as bypass for a ceiling', () => {
  assert.equal(backend([session()]).permissionOf(key), 'manual')
  assert.equal(backend([session({ allowsUnaskedTools: true })]).permissionOf(key), 'bypass')
  // A stopped session's tools are not in force.
  assert.equal(backend([session({ allowsUnaskedTools: true, status: 'stopped' })]).permissionOf(key), 'manual')
})

test('replies are redacted as the tailnet lane redacts them', () => {
  assert.deepEqual(backend([]).redact({ headers: { authorization: 'Bearer x' }, usage: { inputTokens: 4 } }), {
    headers: { authorization: '[redacted]' },
    usage: { inputTokens: 4 },
  })
})
