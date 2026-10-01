# Agent SDK

Drive SprintEngine Studio's agents from your own code: start chats in a
workspace, follow them as they run, answer their approvals and questions,
switch their model and permissions, and stop them. It speaks
[`@sprintengine/studio-protocol`](../studio-protocol/README.md) to the Studio
on this machine, over its owner socket, and runs the same handles in process
inside an extension.

```js
import { approvalRequestOf } from '@sprintengine/agent-sdk'
import { connectToStudio } from '@sprintengine/agent-sdk/node'

const studio = await connectToStudio({
  name: 'release-bot',
  tokenFile: '/Users/me/.config/release-bot/studio.token',
  pairingCode: process.env.STUDIO_PAIRING_CODE, // only the first time
})

const chat = await studio.createConversation({ workspaceId, prompt: 'Draft the release notes.' })
for await (const frame of chat.events()) {
  if (frame.type !== 'event') continue
  const asked = approvalRequestOf(frame.event)
  if (asked?.kind === 'tool') await chat.respondToApproval({ requestId: asked.requestId, decision: 'once' })
  if (frame.event.type === 'turn_completed') break
}
```

`examples/start-and-follow.mjs` is a whole script.

## Pairing

Studio admits only apps a person paired. In Studio, open **Settings → Agents →
Local apps → Pair an app**, name the app, choose what it may do, and the
loosest permission preset its chats may run on. Studio shows a one-time
pairing code, valid for ten minutes. The app's first connection presents the
code and is answered with a token, once: keep it (`tokenFile` does, `0600` in a
`0700` directory) and present it from then on. Studio keeps only the token's
hash. Revoking the app in Settings ends its open connections and its token.

What an app may do is its grant:

| Scope                  | Lets it                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `conversation:read`    | list chats, follow them, read their tool details and diffs                                           |
| `conversation:operate` | send, answer approvals, questions and plans, switch model and preset, interrupt, stop (implies read) |
| `conversation:create`  | start chats                                                                                          |

The **ceiling** is the loosest preset the app's chats may run on. A preset it
asks for above the ceiling is lowered to it, and one it leaves out is pinned to
it; naming `allowedTools` (tools a chat uses without asking) needs a `bypass`
ceiling. A chat the person already runs looser than the ceiling can be read,
interrupted, stopped and denied by the app, but not driven.

Keep a token out of a repository, out of argv and out of the environment of
processes you do not control.

## The client

`connect({ transport, client, auth, onToken?, reconnect?, onStateChange? })`
opens a connection, says hello and resolves once Studio welcomes it.
`connectToStudio` (from `@sprintengine/agent-sdk/node`) does the same for the
Studio on this machine: it finds its data directory (`studioDataDir`), reads
where the socket is from the discovery file Studio writes there
(`discoverStudio`), and keeps the token.

The client keeps its connection:

- It **reconnects** after a drop that reconnecting can fix — Studio quitting
  or restarting, a socket that fell too far behind — with exponential backoff
  and jitter, never sooner than Studio asked. It stops for good on a refusal a
  new connection would repeat (`unauthorized`, `revoked`,
  `unsupported_protocol_version`); `client.closed` rejects with it.
- It **resumes** every open stream from its cursor, so a consumer sees no gap
  and no repeat. A cursor Studio cannot vouch for comes back as a snapshot with
  `reset: true`, and so does any snapshot after a stream's first: replace what
  you held.
- It **sends again** every request unanswered when a connection dropped.
  Every mutation carries a command id — yours, or one minted per call — and
  Studio answers a repeat from its receipt rather than carrying it out twice,
  across reconnects and restarts of the app.
- It **stops reading** while a stream's consumer has two thousand frames
  waiting, so Studio sees the backpressure and merges text deltas rather than
  the client buffering without bound.

Ask features by capability: `client.supports('conversation-create')`. The
welcome (`client.welcome`) names the protocol window, the environment and the
grant; `welcome.conversation` is the conversation contract's own `hello`
answer.

## Conversations

Two layers, over one connection.

`client.createConversation(input)`, `client.conversation(ref)` and
`client.list()` give **handles** for scripts. A handle's methods throw a
`StudioError` (with the protocol's `code`) where Studio refuses:

| Method                                       | Does                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send(message)`                              | a turn; resolves when the turn ends                                                                                                                          |
| `events({ cursor?, turnLimit?, signal? })`   | an async iterator: a `snapshot` (or, from a cursor, only what came after it), a `synchronized` fence, then live `event`s; `stream.cursor` is where it stands |
| `respondToApproval({ requestId, decision })` | `once`, `conversation` or `deny`; never a permanent rule                                                                                                     |
| `answerQuestion({ requestId, answers })`     | a question's text to the chosen answer                                                                                                                       |
| `resolvePlan({ requestId, decision })`       | `approve` or `reject`                                                                                                                                        |
| `setPermissions({ preset, mode? })`          | the preset and the CLI's own mode at it, held to the ceiling                                                                                                 |
| `setModel(modelId)`                          | another model of the same CLI                                                                                                                                |
| `interrupt()`, `stop()`                      | hold the chat back                                                                                                                                           |

`approvalRequestOf(event)` reads what an `approval_requested` event asks.
`allowedTools` is chosen in `createConversation`: the agent's session starts
with them, and they cannot change mid-conversation.

`client.conversations` is the **ref-level service**, named and shaped as the
module SDK's conversation service (`getConversationService(host)`): a ref
`{ workspaceId, agentId }`, an optional `commandId`, and answers of
`{ ok: true, … } | { ok: false, code, message }`, plus `follow` as a callback
stream. Code written against a module's service runs against it unchanged.

## In process

Inside an extension's `entry.main`, `fromModuleConversationService(service)`
gives the same handles over the module SDK's conversation service, with no
socket. The module's own rules still hold: it reaches only the chats it
created, under its declared permissions and ceiling.

```js
import { getConversationService } from '@sprintengine/module-sdk'
import { fromModuleConversationService } from '@sprintengine/agent-sdk'

const conversations = fromModuleConversationService(getConversationService(host))
```

## Environments

The main entry runs in Node and in a browser, given a transport (any object
with `send`, `close`, `onMessage` and `onClose`). `@sprintengine/agent-sdk/node`
adds the socket transport and needs Node 22.12 or later.
