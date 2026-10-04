# Changelog

## 0.1.0 (unreleased)

### Added

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
