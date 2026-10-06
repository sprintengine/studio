# Changelog

## Unreleased

### Added

- **Tools for agents.** `client.tools.offer(toolset)` gives Studio's agents
  tools that run in your program, offered again on every connection;
  `withdraw()`, `focus()` and `catalog()` beside it. A handler gets the calling
  chat, a cancel signal and `progress()`; `toolResult` and `StudioToolError`
  shape its answer. Needs the `client-tools` capability and `tools:offer`.
- **A process run's id.** Every hello carries an `instanceId`, the same across
  one `connect()`'s reconnects, so a call cut off by a drop is answered once.
  `client.kind` may say what a client is; Studio reads it from owners only.

- **A transport's own credential.** `StudioTransport.credential` says the
  hello of that one connection (a ticket minted for it); `auth` is then
  optional.
- **Push streams.** `client.subscribe(topic, params, listener)`, subscribed
  again on every new connection.
- **Folders.** A `ConversationRef` may carry `workspaceRoot`.
- **`resubscribe: false`** on `events` and `follow` ends a stream with
  Studio's error instead of subscribing again by itself.
- **One Studio.** A client is bound to the environment its first connection
  reaches, or to `environmentId`; a reconnect that reaches another is refused
  (`environment_changed`) before any cursor is resumed or request resent.
- **Waking.** A refused credential (`unauthorized`, `revoked`) or being
  offline parks the client (`state: 'parked'`) until `wake()`, or in a browser
  the page coming back online or to the foreground. `parkWhenOffline: false`
  keeps a client of a Studio on the same machine reconnecting while offline.
- **Liveness and timeouts.** `heartbeat` pings a quiet connection and makes a
  silent one again; `readTimeoutMs` (60 s) bounds every read.
- `StudioError.errorId`, and `errorId` on a failed `ConversationResult`.

### Changed

- A revoked or refused client is parked rather than closed; `client.closed`
  settles only on `close()` or a refusal waking cannot help.
- A stream's `cursor` is what its consumer has read, never what is still
  waiting to be read.

## 0.1.0

The first version.

### Added

- **`connect`**: a transport-agnostic client for the Studio protocol that
  reconnects with backoff and jitter, resumes every stream from its cursor,
  sends unanswered requests again under the same command ids, retries `busy`
  answers, keeps a pairing code's token, and pauses reading for a consumer that
  falls behind.
- **Conversation handles**: `createConversation`, `conversation(ref)` and
  `list`, with `send`, `events()` (an async iterator that resumes across
  reconnects), `respondToApproval`, `answerQuestion`, `resolvePlan`,
  `setPermissions`, `setModel`, `interrupt` and `stop`; `approvalRequestOf`.
- **The ref-level service**, `client.conversations`, shaped as the module SDK's
  conversation service.
- **`@sprintengine/agent-sdk/node`**: the owner-socket transport,
  `studioDataDir`, `discoverStudio`, token files and `connectToStudio`.
- **In process**: `fromModuleConversationService` over a module's conversation
  service.
- `examples/start-and-follow.mjs`.
