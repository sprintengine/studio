import assert from 'node:assert/strict'

import type { ConversationPeek } from '../../shared/conversation-peek'
import { createConversationPeekApi } from './conversation-peek'
import { test } from 'vitest'

test('the peek read sends the session id and nothing else', async () => {
  const calls: { channel: string; payload: unknown }[] = []
  const peek: ConversationPeek = {
    sessionId: 'session-1',
    source: 'live',
    first: {
      id: 'live:0',
      text: 'Right now we store the first six words of the prompt as the title.',
      at: 1_757_000_000_000,
      truncatedChars: 0,
    },
    since: [],
  }

  const api = createConversationPeekApi({
    async invoke(channel: string, payload?: unknown): Promise<any> {
      calls.push({ channel, payload })
      return peek
    },
  })

  assert.deepEqual(await api.readConversationPeek('session-1'), peek)
  assert.deepEqual(calls, [{ channel: 'conversation-peek:read', payload: 'session-1' }])
  assert.deepEqual(Object.keys(api), ['readConversationPeek'], 'the peek exposes no open action')
})
