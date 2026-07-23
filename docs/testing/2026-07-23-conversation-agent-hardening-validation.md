# Validation report — conversation agent hardening (T13)

**Run:** `conversation-agent-hardening` (epic 1770) · **Verified:** 2026-07-23 · **Branch:** `sprintengine/conversation-agent-hardening`
**Verdict: Conditional.** Every layer below the live surface is proven by automated tests and repo gates, and the conversation surface itself was driven in the real Electron app (see *Real-app drive*). One acceptance criterion — a *real* multi-agent fan-out with live background subagents — needs a human with a working Claude subscription and is raised to the operator rather than claimed green.

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

## Real-app drive

`AgentChatView` was exercised in the real Electron app via the checked-in pattern in `docs/testing/electron-playwright.md`, on a throwaway profile and a throwaway workspace. **`ELECTRON_RENDERER_URL` was stripped from the child env**, so the window loaded `out/renderer` built from *this* worktree rather than the dev server serving another tree (the first attempt did load `http://localhost:5173` — that run was discarded). Route: onboarding → standard workspace → agent menu → **Conversation agent** (a provider/model pair; `addNewConversationAgent` bails on any non-`standard` workspace mode, and the bare provider row spawns a CLI terminal instead). Screenshots: `.multi-code/sprintengine/conversation-agent-hardening/validation/T13-conversation-surface/`.

| Observed on the live surface | Result |
|---|---|
| Composer at rest | `disabled: false`, accepted typed text — the 1776 gate is gone |
| Model picker (1772) | Opens; lists `Claude Code / your Claude subscription / Sonnet ✓ / Opus / Haiku` — subscription group annotated, live catalog merged over the seed |
| Permission pill (1771) | Reads `Asks before tools`; opens to `Default / Auto / Bypass` with the truthful scope line `Applies when the conversation starts.` for a not-yet-started session |
| Composer context menu (1793) | `Send message ⏎ / Cut ⌘X / Copy ⌘C / Paste ⌘V` — Send present and first |
| Composer chrome (1774) | The attach affordance renders beside Skills / model / permission pills |

Not reachable this way: a metered provider group (no API keys on a fresh profile, so 1772's *non-active key-configured provider* half stays unit-proven), and any assistant turn — every criterion needing a real model response (1773 byline, 1775, 1777, 1792 in situ) requires a live subscription turn.

## Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Tool **and AskUserQuestion** after background-subagent completion is not auto-denied; card surfaces and resolves (1775) | **Verified** | Provider: `testToolAfterResultOpensContinuationInsteadOfDenying` (post-`result` `Bash` → `behavior: 'allow'`), plus `testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack` **added by this task** — the question card is stamped with the continuation turn and the human's answer reaches `updatedInput.answers`. Runtime: continuation-channel test drives `respondToRequest` and asserts `the tool was answered, not auto-denied`. |
| 2 | Background subagents render as live parallel lanes for their real duration (1777) | **Verified at every layer below the screen** | Provider: `testSubagentEventsAfterResultRideTheContinuationChannel` — child `tool_started`/`tool_output` keep `parentToolUseId: 'task_1'` after the turn closed. Renderer: lane nesting, two concurrent lanes reported as a fan-out, a closed lane keeping its own start→output duration (not a child's stamp), and `WorkTimeline` markup showing live lanes open / replayed lanes collapsed. Duration is `completedAt - startedAt` on the lane's own Task call, so it spans the subagent run rather than flashing. |
| 3 | Picker reaches a key-configured provider's catalog while another is active; no key-configured group disappears (1772) | **Verified (unit) + partly live** | Live: the picker opens and merges the subscription provider's live catalog. Had **no test coverage at all**; `buildModelGroups` + `filterModelGroups` extracted and pinned by this task (8 cases): non-active provider's live catalog is reachable, key-present-empty-catalog shows `no-models` instead of vanishing, keyless shows `add-key`, static seeds are never key-gated, one provider's fetch never leaks into another's group, browsing keeps zero-model groups, search looks past the active chip. |
| 4a | Composer type-ahead + queue-while-awaiting-approval (1776) | **Verified** | Live: the composer is editable at rest in the real app. `isConversationBusy` + `composerSendAction` tests: idle sends live; streaming, awaiting-approval, and an in-flight send all queue; a fast second Enter never fires two overlapping sends; type-ahead stays committable while busy. |
| 4b | Live permission switch (1771) | **Verified** | Live: the pill reads the preset in force and opens Default/Auto/Bypass with truthful scope copy. Provider `setPermissionPreset` reaches the running child, survives respawn, and a refusal is surfaced rather than recorded. Runtime `setPermission` + IPC `conversation:sessions:set-permission` validation. Renderer `PermissionPresetPill` names the preset in force and the scope of the change. `conversationSessionAdapter` no longer hardcodes `'default'`. |
| 4c | Image attach round-trip (1774) | **Verified to the SDK boundary** | `buildUserMessageContent` composes text + base64 `image` blocks; `testImageAttachmentsBecomeMultimodalContent`; runtime carries `attachments` to the adapter, accepts an image-only turn, rejects an empty one, and keeps history/JSONL text-only; IPC boundary enforces media type, base64 shape, 5 MB decoded ceiling, 16-per-turn cap; renderer covers rejection rules, downscaling, data-URL splitting, thumbnails. Not proven: a real pasted screenshot landing in a real model's context. |
| 4d | Resolved approvals collapse into an expandable "Approved N" group (1792) | **Verified** | Decisions ride their turn block instead of trailing the prose; text streamed after a batch reads below it; denials keep their own row ahead of the approved run; group mounts `aria-expanded="false"` with requests behind the expander. |
| 5 | Byline restyle (1773) and composer context-menu Send (1793) | **1793 verified; 1773 code-review only** | 1793 live: the menu reads `Send message ⏎ / Cut / Copy / Paste`. 1793 unit: one `composerSendAction` result feeds the button and the menu item, the menu commits through `submitComposer`, Cut only removes on a successful clipboard write, the menu reads the clipboard before opening. 1773 is a pure Tailwind restyle (wrap instead of crush, `TruncatedText` on the name, `--text-muted` at 11px for AA contrast) with no assertion — visual confirmation is a human check. |
| 6 | Unprovable paths raise `needs_input(user)`, not an unproven green | **Done** | Criterion 1's live-app form is escalated (below). |
| 7 | 1778 not in scope, not verified | **Held** | No 1778 work was read, run, or reported on. |

## Findings (all fixed in this task)

- **`src/preload/api/conversation.test.ts` never ran.** The file exists on `main` but is wired into **no** npm script and not into `verify:app`, so T3's new `conversationSessionSetPermission` bridge assertions were dead code. Wired as `test:preload:conversation` (tracker-style `--packages=external` harness) and added to `verify:app` beside the other conversation suites. *(test-coverage, pre-existing, surfaced by T3.)*
- **1772 had zero test coverage.** The group-building rule lived inline in the 2.7k-line component, so the exact regression the item describes — a key-configured provider disappearing for an empty seed — was unpinned. Extracted `buildModelGroups` and `filterModelGroups` as exported pure helpers (behaviour-preserving) and added 8 regression cases. *(test-coverage.)*
- **The acceptance criterion names AskUserQuestion; the tests only covered a plain tool.** Added the post-`result` AskUserQuestion case end to end. *(test-coverage.)*

## Residual risk

- **Live fan-out unproven.** The surface itself drives fine (above), but every criterion that needs an assistant *turn* — tools after background subagents (1775), live parallel lanes and their real durations (1777), the restyled byline (1773), approvals collapsing in situ (1792) — needs a real Claude subscription child running real subagents. No conversation E2E harness exists to script that, and a real fan-out is not reproducible on demand. Those assertions rest on test-doubles of the SDK, not the SDK.
- **Metered providers unproven live.** A fresh profile has no API keys, so 1772's headline case (a key-configured provider that is not the active one) is proven by the new unit tests only.
- **Idle sweep vs. long background work.** `sweepIdleSessions` correctly skips a session with an open turn, including a continuation turn. But the window *before* the child resumes is genuinely idle: a background subagent silent for more than the 15-minute idle threshold can have its child disposed before the continuation ever opens. Pre-existing behaviour, unchanged by this branch, worth a follow-up item rather than a fix here.
- **Images are live-only (D3).** Not persisted or replayed after restart, and claude-agent only. Accepted in the plan.
- **A queued turn can be lost.** If the composer queues a message and the subsequent auto-send fails at `ensureSession`, the text is already cleared from the draft and the queue. Narrow (session start failing at exactly that moment) and not an acceptance regression.
- **1773 is visually unconfirmed** — no screenshot was taken.
