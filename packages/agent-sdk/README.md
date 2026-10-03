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
hash. The code stays good until the token is first presented, so a welcome
lost with its connection, or a token `onToken` could not keep (the connect
fails with `token_not_kept`), is recovered by connecting with the same code
again. Revoking the app in Settings ends its open connections and its token.

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
interrupted, stopped and denied by the app, but not driven; a chat started with
`allowedTools` counts as `bypass` for that. Answering a request `conversation`
(allow its kind for the rest of the chat) needs a ceiling of at least `auto`.

Scopes and the ceiling are not a sandbox. A paired app runs as you, so it can
do anything you can on this machine, including editing Studio's own files to
widen its grant. They keep a trusted app, or a script you gave less than it
could take, within what you chose; pair only software you would run as
yourself.

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
  and jitter, never sooner than Studio asked.
- It **waits to be woken** after a refusal a new connection would repeat. A
  refused credential (`unauthorized`, `revoked`) or being offline parks the
  client (`state: 'parked'`) until `client.wake()`, or in a browser the page
  coming back online or to the foreground; a refused credential also ends what
  was waiting on it. A refusal waking cannot help
  (`unsupported_protocol_version`) closes it for good; `client.closed` rejects
  with it.
- It **follows one Studio**: the one its first connection reaches, or the one
  named by `environmentId`. A reconnect that reaches another is refused
  (`environment_changed`) before a cursor is resumed or a request resent.
- It **resumes** every open stream from its cursor, so a consumer sees no gap
  and no repeat. A cursor Studio cannot vouch for comes back as a snapshot with
  `reset: true`, and so does any snapshot after a stream's first: replace what
  you held. A stream's `cursor` is what you have read from it, never what is
  still waiting, so it is safe to keep after applying a frame.
- It **sends again** every request unanswered when a connection dropped.
  Every mutation carries a command id — yours, or one minted per call — and
  Studio answers a repeat from its receipt rather than carrying it out twice,
  across reconnects and restarts of the app. The same id for a different
  command is refused (`command_id_conflict`).
- It **notices a dead line**: after a quiet spell it asks for `server.ping`,
  and a connection that stays silent is made again (`heartbeat`). A read is
  answered or refused `timeout` within `readTimeoutMs` (60 s).
- It **stops reading** while a stream's consumer has two thousand frames
  waiting, so Studio sees the backpressure and merges text deltas rather than
  the client buffering without bound.

A transport may bring the credential its one connection says hello with
(`StudioTransport.credential`): a ticket minted for that connection alone, as
Studio's own windows use. `auth` is then optional.

`client.subscribe(topic, params, { onPayload, onEnd? })` follows a push topic
such as `conversation.commands`: each payload as it comes, subscribed again on
every new connection, nothing replayed.

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

## Tools for agents

A client may give Studio's agents tools that run in it: a game offering
`spawn_enemy`, a build tool offering `deploy`. Studio lists them to its agents
through the MCP gateway they already reach, sends each call to the client that
offered the tool, and hands the client's answer back. Studio never runs the
tool's code; it decides who may see the tool, picks the client, holds the
deadline, and audits.

It needs the `client-tools` capability and a pairing with "Give agents tools
from this app" (`tools:offer`).

```js
import { toolResult } from '@sprintengine/agent-sdk'

const game = await client.tools.offer({
  name: 'game', // 2–16 lowercase letters, digits or hyphens; agents see `game.spawn_enemy`
  title: 'Acme Game',
  description: 'Controls the level running in Acme Game on this machine.',
  tools: [
    {
      name: 'spawn_enemy',
      description: 'Spawn an enemy at a grid cell. Answers the new enemy id.',
      inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } } },
      timeoutMs: 10_000,
      async handler({ x, y }, call) {
        const id = await level.spawn(x, y, { signal: call.signal })
        return toolResult.text(`Spawned #${id} at ${x},${y}.`, { id })
      },
    },
  ],
})
// …
await game.withdraw()
```

- **Who sees them.** An app's tools reach the chats it started, any chat the
  person opened to it (a chat tab's menu in Studio), or every agent here if
  its pairing says so. Each call still passes the chat's own permissions; the
  approval card says which app the tool is from.
- **A handler** gets its input and a `ToolCall`: the calling chat
  (`conversation`), the agent, a `signal` aborted when Studio stops waiting (the
  turn was interrupted, the deadline passed, the agent left), and `progress()`.
  A string answers as one text part; `toolResult.text`, `.image` and `.error`
  build the rest. Throw a `StudioToolError(code, message)` for a failure the
  agent should read; anything else thrown answers `tool_failed`.
- **Limits.** 32 tools a toolset, 8 toolsets of your own a connection, a schema of 16 KiB
  whose root is an object, and an answer of at most 960 KiB, which fails in
  your process when it is over. A tool's deadline is 60 s unless it names one
  (1 s to 600 s). `STUDIO_TOOL_LIMITS` has them all.
- **Reconnects.** What you offered is offered again on every new connection.
  A call Studio sends again after a drop (the same id, `call.redelivered`)
  joins the handler still running or is answered from the reply already
  given, so a handler runs once per call. A process that restarted is a new
  process to Studio: a call its predecessor was running is not sent to it.
- **Names.** A toolset name is bound to your pairing the first time you offer
  it; another app is refused it (`name_taken`), and Studio's own families
  (`browser`, `canvas`, `workspace`, …) are refused (`reserved_name`).
  Revoking the pairing releases the name and forgets every approval for it.

`client.tools.catalog()` lists the toolsets this client may see, and
`client.tools.focus({ focused, workspaceIds })` tells Studio which workspaces
a client with a screen shows, so a call goes to the one in front of the person.
See `examples/offer-tools.mjs`.

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
