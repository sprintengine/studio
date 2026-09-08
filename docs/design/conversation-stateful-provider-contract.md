# Stateful conversation-provider contract (Claude Agent SDK)

Design note for the Claude Agent SDK conversation provider. Written before
implementation; reviewed against the running code on 2026-07-07.

## Problem

`ConversationRuntime` assumes every provider is **stateless**: it owns the
chat history (`RuntimeSession.history`), replays `[...history, user]` on every
turn, and treats a provider "session" as nothing more than a namespace for
events. The Claude Agent SDK is the opposite: `query()` with a streaming-input
prompt holds a **long-lived child process** that owns its own history, emits
`SDKMessage`s across turns, supports native `interrupt()`, and persists a
resume cursor (`session_id`) that survives app restarts.

## Contract change

One new optional capability on the adapter, discriminated by a `sessions`
field. The stateless shape stays exactly as-is (OpenRouter/mock regression
surface is zero):

```ts
// src/main/providers/conversation-provider-adapter.ts (extracted, main-only)
export type ConversationProviderAdapter = {
  id: string
  listModels(): string[]
  // 'stateless' (default): runtime replays full history each turn.
  // 'stateful': adapter owns history + resume; runtime must NOT replay.
  sessions?: 'stateless' | 'stateful'
  startSession(input): ConversationProviderEventStream
  sendTurn(input): ConversationProviderEventStream
  resolveApproval(input): ConversationProviderEventStream
  interrupt(input): ConversationProviderEventStream
  stopSession(input): ConversationProviderEventStream
}
```

The method set is unchanged — statefulness changes the *semantics*, not the
shape, so the runtime keeps one code path for event fan-out/persistence:

- `sendTurn` on a stateful adapter receives only the new user `message`
  (runtime skips building `messages: [...history, user]` and skips its own
  history bookkeeping).
- `resolveApproval` resolves a pending in-turn permission callback (the SDK
  `canUseTool` promise) instead of replaying a synthetic follow-up turn; the
  turn then **continues streaming** within the same `sendTurn` event stream.
- `interrupt` maps to the SDK's native `interrupt()`.
- `stopSession` disposes the child process but keeps the resume cursor.

### Runtime branching (conversation-runtime.ts)

- **History**: `if (adapter.sessions !== 'stateful')` guard around history
  replay and history recording. Stateful sessions leave `history` empty.
- **Approvals**: today the runtime pre-allocates one `requestId` per turn and
  flips `awaiting_approval` at end-of-stream. Stateful providers surface
  approvals **mid-stream** (the SDK blocks inside `canUseTool` while the
  stream stays open). The runtime therefore:
  - forwards mid-stream `approval_requested` events as they are emitted
    (fan-out already does this);
  - tracks `session.pendingRequestId` from the event payload (set on
    `approval_requested`, cleared on `approval_resolved`) via a listener in
    the emit path rather than only from `applyTurnState`;
  - `respondToRequest` routes to `adapter.resolveApproval` while the turn is
    still active; for stateless adapters the legacy end-of-stream behavior is
    preserved (guarded by `sessions !== 'stateful'`).
  - `sendTurn` returns when the turn's stream ends (`turn_completed` /
    `turn_failed`), exactly as today; a pending approval keeps the stream
    open, so the existing "await emitAll" model needs no re-architecture.
- **Send-while-awaiting**: unchanged rule (reject sends while
  `pendingRequestId` is set) for both kinds.

### Resume cursor persistence

Stateful adapters need `{ providerSessionId }` durable per (workspace, agent).
The conversation JSONL transcript is already the durable per-agent record, so
the cursor rides it: the adapter emits a `session_started` event whose payload
carries `providerSessionId` (the SDK `session_id` from the `init` system
message, updated on every turn's result message via `session_updated`
payloads). On `startSession`, the runtime reads the tail of the existing
JSONL (if any) for the latest `providerSessionId` and passes it to the adapter
as `input.resumeSessionId`. No new store, no settings-store setter.

### Provider identity & listing

- Adapter id: `claude-agent`. Registered as a **bundled adapter** in the
  `ConversationRuntime` default adapter list (like `mock-provider`), plus a
  bundled manifest entry so `conversation:providers:list` surfaces it with
  models and `requiresSecret: false`.
- Manifest: new optional `kind: 'cli-agent'` marker on the conversation
  provider manifest (`src/shared/plugin-manifest.ts`) so the renderer can
  show "uses your Claude Code subscription" copy and skip API-key affordances.
- Availability gate: the provider is listed only when the Claude Code CLI
  resolves (same resolution as `terminal-launch.ts`: `appSettings.cliRuntimes`
  command override, else PATH lookup). Models come from a static list of CLI
  model aliases (`sonnet`, `opus`, `haiku`, `default`) — the CLI accepts
  aliases and full model ids; no remote catalog call.

### SDK containment

- Exact-pinned `@anthropic-ai/claude-agent-sdk` (no `^`).
- All SDK types stay inside `src/main/providers/claude-agent-provider.ts`.
- New `ConversationEvent` variants stay provider-neutral and live in
  `src/shared/conversation-runtime.ts` (shared never imports main).

### Event mapping (SDKMessage → ConversationEvent)

| SDK | Canonical |
| --- | --- |
| `system/init` | `session_started` payload `{ providerSessionId, model }` |
| `stream_event: content_block_delta text_delta` | `content_delta` |
| `stream_event: content_block_delta thinking_delta` | `reasoning_delta` |
| `assistant` message `tool_use` blocks | `tool_started` (name + input summary) |
| `user` message `tool_result` blocks | `tool_output` |
| `result success` | `usage_updated` + `turn_completed` |
| `result error*` | `turn_failed` |
| `canUseTool` callback | `approval_requested` … `approval_resolved` |
| rate-limit / auth notices | `turn_failed` reason `auth` (v1) |

Everything unrecognized is dropped (forward-compatible with SDK churn).

### Process lifecycle (hooks for MC-1481)

The adapter keeps a session registry `sessionId → { query, child env marker,
lastTurnAt, pendingPermission }` and exposes `listLiveSessions()` +
`disposeAll()`. The SDK child is spawned with
`env.MULTICODE_CONVERSATION_SESSION={sessionId}` so process-tree metrics can
attribute it. Idle reaping and quit disposal are wired in MC-1481, not here —
but dispose-with-resume must already work (stop keeps the cursor; next
`startSession` resumes).

## Rejected alternatives

- **Separate `StatefulConversationProviderAdapter` interface with its own
  runtime path** — doubles the runtime surface and forks event persistence;
  the event-stream model already accommodates mid-stream approvals.
- **Resume cursor in a settings/store sidecar** — the JSONL transcript is
  already the durable conversation record; a second store can desync and
  needs a new setter in two type surfaces (known typecheck trap).
- **Replaying our own history into the SDK** — defeats native resume, breaks
  subscription-side caching, and duplicates the CLI's own transcript.
