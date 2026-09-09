import assert from 'node:assert/strict'

import type { ConversationPeek } from '../../shared/conversation-peek'
import { createConversationPeekApi } from './conversation-peek'

async function main(): Promise<void> {
  const calls: { channel: string; payload: unknown }[] = []
  const peek: ConversationPeek = {
    sessionId: 'session-1',
    source: 'transcript',
    first: {
      id: 'uuid-1',
      text: 'Right now we store the first six words of the prompt as the title.',
      at: 1_757_000_000_000,
      attachments: [{ kind: 'image', id: 'uuid-1:image:0', label: 'Screenshot.png' }],
      truncatedChars: 0,
    },
    since: [],
    images: [{ kind: 'image', id: 'uuid-1:image:0', label: 'Screenshot.png' }],
  }

  const api = createConversationPeekApi({
    async invoke(channel: string, payload?: unknown): Promise<any> {
      calls.push({ channel, payload })
      return channel === 'conversation-peek:read' ? peek : undefined
    },
  })

  assert.deepEqual(await api.readConversationPeek('session-1'), peek)
  await api.openConversationPeekAttachment('session-1', 'uuid-1:image:0')

  // The open call sends ids only: the renderer never names a path or a file, so
  // nothing it can send widens what main will read or open.
  assert.deepEqual(calls, [
    { channel: 'conversation-peek:read', payload: 'session-1' },
    {
      channel: 'conversation-peek:open-attachment',
      payload: { sessionId: 'session-1', attachmentId: 'uuid-1:image:0' },
    },
  ])

  console.log('conversation-peek preload tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
