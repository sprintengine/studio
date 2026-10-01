# Changelog

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
- **Publishable.** `publishConfig`, `repository` and this changelog. Publishing
  is a separate release step.

## 0.1.0

The direct conversation lane on the tailnet gateway: frames, the client-frame
validator, tool classification and presentation.
