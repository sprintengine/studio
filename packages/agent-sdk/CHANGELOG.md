# Changelog

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
