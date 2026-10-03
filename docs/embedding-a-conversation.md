# Embedding a conversation

Another app can show a Studio conversation, read-only, in two ways. Both read
and never act: nothing in an embedded conversation sends a message, answers an
approval or opens a file.

## An iframe, for any page

The Studio server serves one conversation as a page of its own, which any
page can frame. It needs the server's web listener (`studio-server serve
--web`).

```
studio-server embed --workspace <workspace id> --agent <agent id> \
  --frame-origin https://dashboard.example.com [--ttl-hours 24]
```

prints a link, `http://127.0.0.1:4791/embed/conversation/<id>#token=mcemb_…`.
Frame it:

```html
<iframe src="LINK" title="Conversation" style="width: 100%; height: 600px; border: 0"></iframe>
```

- **Who may frame it** is the list of `--frame-origin`s (repeatable); the
  page is served with `frame-ancestors` set to them, read from the embed on
  every load. An embed with none cannot be framed, only opened.
- **The token** is in the fragment, which no server and no `Referer` sees.
  The page removes it from its address at once, and trades it for a
  single-use socket ticket. A page that would rather not put it in a URL can
  frame the link without `#token=…` and post it instead (below).
- **What the token can do** is follow and page through that one
  conversation: its connection is read-only, refused anything else, and the
  server redacts what it reads as it does for any app.
- **It expires** after 24 hours unless asked for longer (30 days at most).
  `studio-server embed --list` prints every embed the server holds, and
  `studio-server embed --revoke <embed id>` takes one back. Revoking closes
  its connections at once. There is no Settings surface for embeds yet.

### Talking to the frame

The frame and the page talk by `postMessage`, every message carrying `v: 1`
(the wire's row is in `docs/compatibility.md`). The frame posts only to the
embed's own origins and accepts only messages from its parent on them.

From the frame:

| Message | Meaning |
| --- | --- |
| `{ v: 1, type: 'ready', embedId }` | the page has loaded |
| `{ v: 1, type: 'resize', height }` | its content's height, to size the frame |
| `{ v: 1, type: 'link', href }` | a link the person clicked; open it as your page sees fit |
| `{ v: 1, type: 'state', turns, working }` | how many turns, and whether one is running |
| `{ v: 1, type: 'error', code }` | `embed_unavailable`, `unreachable`, `unsupported_version` |

To the frame:

| Message | Meaning |
| --- | --- |
| `{ v: 1, type: 'theme', mode }` | `light`, `dark` or `system` |
| `{ v: 1, type: 'token', token }` | the embed's token, for a link framed without it |
| `{ v: 1, type: 'scrollTo', turnId }` | bring a turn into view |

```js
const frame = document.querySelector('iframe')
window.addEventListener('message', (event) => {
  if (event.origin !== 'http://127.0.0.1:4791' || event.source !== frame.contentWindow) return
  if (event.data.type === 'resize') frame.style.height = `${event.data.height}px`
  if (event.data.type === 'ready') frame.contentWindow.postMessage({ v: 1, type: 'theme', mode: 'dark' }, event.origin)
})
```

## A React component, for an app with its own connection

An app that already reaches Studio with `@sprintengine/agent-sdk` (a paired
local app, or a desktop shell of its own) can draw a conversation itself with
`@sprintengine/conversation-view`, over that connection:

```tsx
import { ConversationView } from '@sprintengine/conversation-view'

<ConversationView source={client.conversations} conversation={{ workspaceId, agentId }} theme={{ mode: 'system' }} />
```

The component draws inside a shadow root of its own and is themed through a
few `--se-*` tokens; `packages/conversation-view/README.md` has the details
and `packages/conversation-view/examples/ReadOnlyConversation.tsx` a
complete component. For rows without React, `@sprintengine/conversation-timeline`
follows a conversation and folds it into the rows the view draws.

A page that does not hold a Studio credential uses the iframe: it is the
security boundary, and the component is for apps trusted with a connection.
