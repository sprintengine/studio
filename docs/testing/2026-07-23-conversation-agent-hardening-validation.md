# Validation report — conversation agent hardening (T13)

**Run:** `conversation-agent-hardening` (epic 1770) · **Verified:** 2026-07-23 · **Branch:** `sprintengine/conversation-agent-hardening`
**Verdict: Conditional.** Every layer below the live Electron surface is proven by automated tests and repo gates. One acceptance criterion — a *real* multi-agent fan-out driven end to end in the running app — is not provable in this environment and is raised to the operator rather than claimed green.

## Scope reviewed

The accumulated branch diff for T1–T12 (24 files, ~4.0k insertions): `src/main/providers/claude-agent-provider.ts`, `src/main/conversation-runtime.ts`, `src/main/ipc/conversation-ipc.ts`, `src/preload/api/conversation.ts`, `src/shared/conversation-runtime.ts`, `src/renderer/src/components/panels/AgentChatView.tsx`, `conversationSessionAdapter.ts`, `agentSpawnShared.tsx`. **1778 is out of scope and was not verified.**

## Checks run

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run build` (incl. bundle budget) | pass — eager chunk 2022 KB, no forbidden deps |
| `npm run test:main:claude-agent-provider` | pass |
| `npm run test:main:conversation-runtime` | pass |
| `npm run test:main:conversation-ipc` | pass |
| `npm run test:preload:conversation` | pass (**newly wired — see findings**) |
| `npm run test:renderer:agent-chat-view` | pass |
| `npm run test:renderer:guided-brief-conversation` | pass |
| `npm run test:renderer:conversation-spawn-options` | pass |

## Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Tool **and AskUserQuestion** after background-subagent completion is not auto-denied; card surfaces and resolves (1775) | **Verified** | Provider: `testToolAfterResultOpensContinuationInsteadOfDenying` (post-`result` `Bash` → `behavior: 'allow'`), plus `testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack` **added by this task** — the question card is stamped with the continuation turn and the human's answer reaches `updatedInput.answers`. Runtime: continuation-channel test drives `respondToRequest` and asserts `the tool was answered, not auto-denied`. |
| 2 | Background subagents render as live parallel lanes for their real duration (1777) | **Verified at every layer below the screen** | Provider: `testSubagentEventsAfterResultRideTheContinuationChannel` — child `tool_started`/`tool_output` keep `parentToolUseId: 'task_1'` after the turn closed. Renderer: lane nesting, two concurrent lanes reported as a fan-out, a closed lane keeping its own start→output duration (not a child's stamp), and `WorkTimeline` markup showing live lanes open / replayed lanes collapsed. Duration is `completedAt - startedAt` on the lane's own Task call, so it spans the subagent run rather than flashing. |
| 3 | Picker reaches a key-configured provider's catalog while another is active; no key-configured group disappears (1772) | **Verified** | Had **no test coverage at all**; `buildModelGroups` + `filterModelGroups` extracted and pinned by this task (8 cases): non-active provider's live catalog is reachable, key-present-empty-catalog shows `no-models` instead of vanishing, keyless shows `add-key`, static seeds are never key-gated, one provider's fetch never leaks into another's group, browsing keeps zero-model groups, search looks past the active chip. |
| 4a | Composer type-ahead + queue-while-awaiting-approval (1776) | **Verified** | `isConversationBusy` + `composerSendAction` tests: idle sends live; streaming, awaiting-approval, and an in-flight send all queue; a fast second Enter never fires two overlapping sends; type-ahead stays committable while busy. |
| 4b | Live permission switch (1771) | **Verified** | Provider `setPermissionPreset` reaches the running child, survives respawn, and a refusal is surfaced rather than recorded. Runtime `setPermission` + IPC `conversation:sessions:set-permission` validation. Renderer `PermissionPresetPill` names the preset in force and the scope of the change. `conversationSessionAdapter` no longer hardcodes `'default'`. |
| 4c | Image attach round-trip (1774) | **Verified to the SDK boundary** | `buildUserMessageContent` composes text + base64 `image` blocks; `testImageAttachmentsBecomeMultimodalContent`; runtime carries `attachments` to the adapter, accepts an image-only turn, rejects an empty one, and keeps history/JSONL text-only; IPC boundary enforces media type, base64 shape, 5 MB decoded ceiling, 16-per-turn cap; renderer covers rejection rules, downscaling, data-URL splitting, thumbnails. Not proven: a real pasted screenshot landing in a real model's context. |
| 4d | Resolved approvals collapse into an expandable "Approved N" group (1792) | **Verified** | Decisions ride their turn block instead of trailing the prose; text streamed after a batch reads below it; denials keep their own row ahead of the approved run; group mounts `aria-expanded="false"` with requests behind the expander. |
| 5 | Byline restyle (1773) and composer context-menu Send (1793) | **1793 verified; 1773 code-review only** | 1793: one `composerSendAction` result feeds the button and the menu item, the menu commits through `submitComposer`, Cut only removes on a successful clipboard write, the menu reads the clipboard before opening. 1773 is a pure Tailwind restyle (wrap instead of crush, `TruncatedText` on the name, `--text-muted` at 11px for AA contrast) with no assertion — visual confirmation is a human check. |
| 6 | Unprovable paths raise `needs_input(user)`, not an unproven green | **Done** | Criterion 1's live-app form is escalated (below). |
| 7 | 1778 not in scope, not verified | **Held** | No 1778 work was read, run, or reported on. |

## Findings (all fixed in this task)

- **`src/preload/api/conversation.test.ts` never ran.** The file exists on `main` but is wired into **no** npm script and not into `verify:app`, so T3's new `conversationSessionSetPermission` bridge assertions were dead code. Wired as `test:preload:conversation` (tracker-style `--packages=external` harness) and added to `verify:app` beside the other conversation suites. *(test-coverage, pre-existing, surfaced by T3.)*
- **1772 had zero test coverage.** The group-building rule lived inline in the 2.7k-line component, so the exact regression the item describes — a key-configured provider disappearing for an empty seed — was unpinned. Extracted `buildModelGroups` and `filterModelGroups` as exported pure helpers (behaviour-preserving) and added 8 regression cases. *(test-coverage.)*
- **The acceptance criterion names AskUserQuestion; the tests only covered a plain tool.** Added the post-`result` AskUserQuestion case end to end. *(test-coverage.)*

## Residual risk

- **Live fan-out unproven.** The Electron conversation surface with a real Claude Code child running real background subagents is not drivable headless (no conversation E2E harness exists in the repo; the only e2e script is `verify:third-party-modules-e2e`). Everything asserted above is a test-double of the SDK, not the SDK.
- **Idle sweep vs. long background work.** `sweepIdleSessions` correctly skips a session with an open turn, including a continuation turn. But the window *before* the child resumes is genuinely idle: a background subagent silent for more than the 15-minute idle threshold can have its child disposed before the continuation ever opens. Pre-existing behaviour, unchanged by this branch, worth a follow-up item rather than a fix here.
- **Images are live-only (D3).** Not persisted or replayed after restart, and claude-agent only. Accepted in the plan.
- **A queued turn can be lost.** If the composer queues a message and the subsequent auto-send fails at `ensureSession`, the text is already cleared from the draft and the queue. Narrow (session start failing at exactly that moment) and not an acceptance regression.
- **1773 is visually unconfirmed** — no screenshot was taken.
