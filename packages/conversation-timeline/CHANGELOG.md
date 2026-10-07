# Changelog

## 0.1.0 (unreleased)

### Added

- A user entry carries `files`, the files the message attached by path, read
  from a `user_message`'s `files` member (`{ path }` each), and a local turn
  passes its own through. `parseConversationAttachedFiles` is the reader and
  `attachedFileName` names one; a view draws a message's file cards from this
  list, never from its text.

- A user entry carries the `origin` its `user_message` recorded, for a message
  the desktop sent the chat itself, so a view can draw it as Studio's rather
  than as the person's.

- `ConversationUsage` carries `contextWindow` and `contextUsed` from
  `usage_updated`, each kept until a report moves it (a compaction resets
  `contextUsed` to what the summary left). `nextConversationUsage` is the fold,
  shared by the full and the incremental projection.

- The projection, incremental projection and timeline Studio's chat view
  draws from, moved here unchanged so the app and other views share one
  implementation.
- `createConversationFollower`: follow one conversation over a Studio
  connection and read it as rows, with paging to earlier turns.
- `checkConversationTimelineProtocol`: the conversation protocol window the
  package reads, checked against a Studio's welcome.
- `turn_retrying` is read: the turn's entry carries the latest `retry`
  until the turn reports anything else, and the working row says why and
  which attempt (`retryLabel`), in place of "Thinking…".
