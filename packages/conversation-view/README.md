# @sprintengine/conversation-view

A SprintEngine Studio conversation, read-only, as a React component your app
renders over its own Studio connection.

The view follows one conversation and draws its turns, replies (as text, never
as HTML), tool steps and decisions. It reads and never acts: it sends nothing,
answers no approval and opens nothing itself; a clicked link goes to your
`onLink`.

For a page that should not hold a Studio credential, embed the iframe instead
(`studio-server embed` prints its link): the iframe is the security boundary,
and this component is for apps that already hold a connection.

## Use

```tsx
import { connect } from '@sprintengine/agent-sdk'
import { ConversationView } from '@sprintengine/conversation-view'

const client = await connect({ transport, client: { name: 'My dashboard' }, auth: { token } })

export function Chat({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  return (
    <ConversationView
      source={client.conversations}
      conversation={{ workspaceId, agentId }}
      theme={{ mode: 'system', tokens: { accent: '#5b5bd6' } }}
      onLink={(href) => window.open(href, '_blank', 'noopener,noreferrer')}
    />
  )
}
```

`examples/ReadOnlyConversation.tsx` is a complete component that connects,
checks the server's protocol and draws the view.

## Styling

By default the view draws inside a shadow root it makes, so your page's
styles and its own do not meet. `isolation="none"` draws it in your page
instead, with its rules scoped to `.se-conversation` under
`@layer sprintengine`, for a page that wants to restyle it.

The public styling contract is a small set of custom properties, set through
`theme.tokens` (or on the host element):

| Token                                                               | Use                   |
| ------------------------------------------------------------------- | --------------------- |
| `--se-bg`, `--se-surface`, `--se-well`, `--se-border`               | grounds and hairlines |
| `--se-text`, `--se-text-muted`, `--se-link`                         | ink                   |
| `--se-accent`, `--se-danger`                                        | focus and failures    |
| `--se-font-body`, `--se-font-mono`, `--se-font-size`, `--se-radius` | type and shape        |

`theme.mode` is `light`, `dark` or `system`, set on the view's own root,
never on your page. The view inherits your fonts unless you set the font
tokens; it loads none.

## Versioning

0.x: the props may change between minor versions, and the changelog says
when. React 19 is a peer dependency. The rows come from
`@sprintengine/conversation-timeline`, which is installed with it.
