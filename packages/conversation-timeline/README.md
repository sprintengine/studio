# @sprintengine/conversation-timeline

A SprintEngine Studio conversation as the rows a view draws, with no React,
DOM or Electron in it.

- **The projection** folds a conversation's events (the conversation
  protocol's `ConversationEvent`) into entries: user turns, replies, tool
  steps, the agents a turn spawned, approvals and questions.
- **The timeline** groups those entries into rows: one per user turn, one
  per reply with its steps and decisions, and the notes between them.
- **The follower** keeps both current over a Studio connection: give it what
  follows a conversation (an `@sprintengine/agent-sdk` client's
  `conversations`) and the conversation's address, and read its state.

It is the same code Studio's own chat view runs, so a conversation reads the
same here as in the app.

## Use

```ts
import { connect } from '@sprintengine/agent-sdk'
import { checkConversationTimelineProtocol, createConversationFollower } from '@sprintengine/conversation-timeline'

const client = await connect({ transport, client: { name: 'My dashboard' }, auth: { token } })
const supported = checkConversationTimelineProtocol(client.welcome.conversation)
if (!supported.ok) throw new Error(supported.message)

const follower = createConversationFollower(client.conversations, { workspaceId, agentId }, { turnLimit: 10 })
follower.subscribe(() => {
  const { rows, hydrated, hasMore } = follower.getState()
  // Draw `rows`: kind 'user', 'assistant' (with its `tools` and `decisions`),
  // 'approval', 'compaction', 'commandOutput' and 'working'.
})
await follower.loadEarlier() // the turns before the earliest held
follower.dispose()
```

A view checks the server's conversation protocol before it follows anything
(`checkConversationTimelineProtocol`), and draws the refusal, which names both
versions, instead of a conversation it might misread.

## Versioning

While the package is 0.x, the row model (`ConversationTimelineRow` and the
entries it carries) may change between minor versions; the changelog says
when. From 1.0 it is public API. New event types are additive: the projection
skips a type it does not know.

The conversation protocol is a dependency, not a copy:
`@sprintengine/conversation-protocol` must be installed beside it.
