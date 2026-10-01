# Changelog

## 0.1.0

The first version: what Studio serves on its owner socket.

### Added

- **The envelope.** `hello` / `welcome` / `bye`, requests answered under their
  id (`res`), streams keyed by subscription (`sub`, `frame`, `subFailed`,
  `unsub`) and chunking for frames over `STUDIO_MAX_FRAME_BYTES`, with their
  validators for both ends (`parseStudioClientFrame`,
  `parseStudioServerFrame`) and a chunk assembler for clients.
- **The handshake.** `STUDIO_PROTOCOL_VERSION` (1) and its window,
  `checkStudioProtocolVersion`, and the Studio capabilities `conversations`,
  `conversation-create` and `local-pairing`. The conversation contract's
  `hello` answer is nested in the `welcome` unchanged.
- **Scopes and grants.** `conversation:read`, `conversation:operate` and
  `conversation:create`, and a grant's permission `ceiling`.
- **The method table.** `STUDIO_METHODS` and `STUDIO_TOPICS`, each naming its
  scope, for the `server` and `conversation` namespaces; params validated by
  `parseStudioMethodParams`, a command's through the conversation lane's own
  validator.
- **Discovery.** The `server.json` a running Studio writes beside its socket.
- **The conversation contract**, re-exported from
  `@sprintengine/conversation-protocol`, which this package depends on.
