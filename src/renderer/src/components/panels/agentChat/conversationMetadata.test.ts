import { expect, test } from 'vitest'
import { projectConversation, userEntryFromLocalTurn } from './conversationProjection'
import type { ConversationEvent } from '../../../../../shared/conversation-runtime'

test('local and replayed user bubbles retain reference metadata, not file contents', () => {
  const mentions = [{ path: 'src/app.ts', kind: 'file' as const, line: 3 }]
  const skills = ['review']
  expect(userEntryFromLocalTurn({ id: 'local', text: 'Check this', mentions, skills })).toMatchObject({
    mentions,
    skills,
  })
  const event: ConversationEvent = {
    id: 'message',
    seq: 4,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type: 'user_message',
    createdAt: 1,
    payload: { turnId: 'turn', text: 'Check this', mentions, skills },
  }
  expect(projectConversation([event]).entries[0]).toMatchObject({ kind: 'user', mentions, skills })
  expect(
    projectConversation([{ ...event, payload: { ...event.payload, localTurnId: 'local' } }]).entries[0],
  ).toMatchObject({ id: 'local' })
  expect(
    projectConversation([{ ...event, payload: { ...event.payload, mentions: ['invalid'], skills: [null, 'review'] } }])
      .entries[0],
  ).toMatchObject({ mentions: undefined, skills })
})
