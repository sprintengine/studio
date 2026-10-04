# Changelog

## Unreleased

### Added

- **`usage_updated` says how full the context window is.** `contextWindow`
  (the model's window, in tokens) and `contextUsed` (the tokens in it now:
  the latest request's size, not a sum) are reported by Claude Code and Codex
  chats as well as ACP agents, which already sent them. Both are optional
  payload members, so a reader that does not know them skips them, and the
  wire validator passes them through. The pinned files are unchanged.
- **A listed chat names its machine and its pull requests.** `host`
  (`ConversationWireHost`: `id`, `kind`, `label`, `color`) and `pullRequests`
  (`ConversationWirePullRequest`: `number`, `state`, `url`, `title`, at most
  `CONVERSATION_MAX_PULL_REQUESTS`) are optional members of
  `ConversationThread`, kept by `parseConversationServerFrame` and validated
  on their own by `parseConversationWireHost` and
  `parseConversationWirePullRequests`. An unreadable one is left out and the
  row kept. The pinned files are unchanged.
- **`turn_retrying`**, an event for a model call the provider will try
  again, with `ConversationTurnRetryingPayload` (`attempt`, `maxAttempts`,
  `retryInMs`, and the failure's `error` category and HTTP `status`). Until
  now a turn that kept failing and retrying showed nothing until the provider
  gave up. A client that does not know the type skips it.
- **The tool presentation is public.** `presentToolItem`, `toolActionVerb`
  and `summarizeToolGroup` (with `PresentableTool` and `ToolPresentation`)
  are exported from the entry, for views that word a tool step as Studio
  does. The pinned files are unchanged.

## 0.2.0

The package becomes the one conversation contract: what the tailnet lane, the
module SDK and the desktop's own chat view all speak.

### Added

- **The package entry is `public.ts`.** It publishes the first version's
  frames and helpers (`index.ts`, unchanged byte for byte, because the phone
  app carries those files under a shared pin), the client-side server-frame
  validator (`parseConversationServerFrame`, `parseConversationWireEvent`),
  which the entry did not export before, and everything below.
- **The event layer.** `ConversationEvent`, `ConversationEventType` with its
  value list `CONVERSATION_EVENT_TYPES` and `isConversationEventType`,
  `ConversationSessionStatus`, the payload types (`tool_started`,
  `tool_output`, `subagent_status`, `subagent_message`, `approval_requested`,
  `approval_resolved`), `ConversationQuestion`, `ConversationPage`, the stream
  frames a follower receives (`ConversationStreamFrame`) and the resume
  cursor (`ConversationCursor`). These were the desktop's own declarations;
  the desktop now imports them from here.
- **The command vocabulary.** `ConversationCommand` extends the wire's
  commands with `resolvePlan` (`approve` or `reject`, behind
  `conversation-plans`) and a `permissionMode` on `setPermissionPreset`
  (behind `conversation-cli-permission-modes`); `ConversationRequestDecision`
  names the three answers a client may give a tool request and never a
  permanent rule. `parseConversationClientMessage` and
  `explainRejectedConversationMessage` read the full contract and read every
  first-version frame exactly as `parseConversationClientFrame` does.
- **Create requests.** `ConversationCreateRequest`, with `allowedTools`, and
  its validator `parseConversationCreateRequest`.
- **The handshake.** `CONVERSATION_PROTOCOL_VERSION` (1) and
  `CONVERSATION_PROTOCOL_MIN_SUPPORTED`, the `hello` request and its answer
  (`parseConversationHelloAnswer`), `checkConversationProtocolVersion`, and
  `CONVERSATION_CAPABILITIES`, every capability name the lane has shipped.
- **Listed modes.** `ConversationThread` is a listed thread with its
  `permissionMode` and `capabilities.permissionModes`, which
  `parseConversationServerFrame` now keeps.
- **Publishable.** `publishConfig`, `repository` and this changelog. Publishing
  is a separate release step.

## 0.1.0

The direct conversation lane on the tailnet gateway: frames, the client-frame
validator, tool classification and presentation.
