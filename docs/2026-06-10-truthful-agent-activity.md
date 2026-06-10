# Truthful Agent Activity in the Session Manager

Status: draft for review · 2026-06-10

## Problem

The session manager popover (`src/renderer/src/components/workspace/WorkspaceTopBar.tsx`,
`SessionsPopover`) shows a pulsing green "Working" dot for **every live session**,
forever. The dot is not derived from any activity signal:

- `getSessionItems` (`src/renderer/src/components/workspace/workspaceManagerHelpers.ts:64`)
  hardcodes `status: 'working'` for every live agent session unless the Sprint
  Engine MCP runtime says `needs_input`, and for every plain terminal
  unconditionally.
- The main process *does* track real activity per session
  (`SessionActivity`: working / idle / exited / failed, plus `lastOutputAt`,
  `lastInputAt`, `startedAt`, `exitedAt` — all already on
  `TerminalSessionSnapshot`), but the session manager never reads it.

So an agent that finished an hour ago pulses "Working". The user cannot tell
which agents are actually working, which are waiting for them, and how long ago
anything happened. This plan fixes that in three phases: stop lying with the
data we already have, then make the underlying signal honest, then make it
ground-truth per CLI.

## How status is computed today (signal inventory)

| Signal | Where | Mechanics | Trust level |
| --- | --- | --- | --- |
| `SessionActivity` | `src/main/terminal-session.ts`, `src/main/terminal-runtime.ts` (`attachTerminalSession`, `scheduleTerminalIdleTransition`) | Any PTY output → `working`; no output for 3 s (terminal) / 4 s (agent) → `idle`; process exit → `exited`/`failed` | Weak heuristic |
| `lastOutputAt` / `lastInputAt` / `startedAt` / `exitedAt` | same | Timestamps on every output/input chunk | Factual, but only rebroadcast on activity transitions |
| Sprint Engine `needs_input` | `workspace.sprintEngineState.sprintEngineAgents[id].status`, fed by the managed MCP server | Agent self-reports through MCP tools | Ground truth, Sprint Engine roster agents only |
| Readiness / sentinel pattern matching | `src/main/agent-stream-watcher.ts` + plugin descriptors | Rolling-buffer regex over PTY output (used for prompt injection and completion only) | Existing machinery, not used for status |

Broadcast model: `broadcastTerminalSessionsChanged` fires on activity
*transitions* and spawn/exit, not on every output chunk — so consuming
`activity.since` in the renderer is cheap and needs no new IPC traffic. The
renderer already has `useRelativeNow` and `formatRelativeMsAgo`
(`src/renderer/src/utils/relativeTime.ts`), and the tab strip already shows
recency via `pickAgentTabRecency` (`src/renderer/src/hooks/useTerminalSessions.ts`).

## Why it lies (failure modes)

1. **Session manager ignores everything.** Live = pulsing "Working". The
   primary complaint; pure renderer bug.
2. **Needs-input is invisible outside Sprint Engine.** A standard agent sitting
   at a permission prompt or AskUserQuestion emits no output → even honest
   output-recency reads it as *idle*. This is the most expensive state to miss,
   and it is exactly the state output-recency cannot see.
3. **False idle during quiet work.** A CLI that runs a silent tool call > 4 s
   without repainting flips to idle while genuinely working. (Claude Code's
   spinner repaints continuously, so it mostly survives this; other CLIs may
   not.)
4. **False working from ambient output.** A plain terminal running `tail -f`
   or any animation is "working" forever.
5. **No recency anywhere.** "How long ago did this agent do anything" exists in
   the data (`lastOutputAt`) but is never shown in the session manager.
6. **Failed sessions vanish.** Retained failed sessions
   (`createFailedTerminalSession`) have `processAlive: false`, so
   `getSessionItems` filters them out — a crashed agent silently disappears
   from the list instead of demanding attention.

## Target model

One canonical per-session attention state, merged from prioritized signals:

```
AgentAttention =
  | working      (since, source)
  | needs-input  (since, reason?: permission | question | idle-prompt, source)
  | idle         (since, lastActivityAt)
  | failed       (at, exitCode, message?)
  | exited       (at, exitCode)
```

Signal precedence (highest wins, with staleness decay back to the next tier):

1. **CLI adapter events** (Claude Code hooks / Codex notify / transcript watch) — Phase 3
2. **Sprint Engine MCP `needs_input`** (roster agents; stays renderer-merged)
3. **Manifest-declared screen patterns** (permission prompt visible, "esc to
   interrupt" visible, composer at rest) — Phase 2
4. **Terminal bell (BEL)** → attention ping — Phase 2
5. **Output recency** (`SessionActivity`) — today's heuristic, demoted to fallback

Every tier is per-CLI pluggable via the plugin manifest, consistent with the
open-ended agent-CLI roadmap (claude-code, codex, opencode, user-defined). The
manifest already has precedent slots: `promptInjection.readiness`
(output-match pattern) and `completion` (`idle-at-prompt` + `promptPattern`),
validated in `src/main/plugin-manifest-validate.ts`.

---

## Phase 1 — Stop lying with data we already have (renderer only)

Smallest change that makes the session manager honest. No main-process or IPC
changes.

1. **`getSessionItems`** (`workspaceManagerHelpers.ts`): derive a three-state
   status instead of hardcoding `working`:
   - `needs-input` — Sprint Engine runtime `needs_input` (unchanged, still tier 1).
   - `working` — `session.activity.kind === 'working'`.
   - `idle` — otherwise. Carry `activitySince` (= `activity.since`) and
     `lastActivityAt` (= max of `lastOutputAt`, `lastInputAt`) on `SessionItem`.
   - Include retained **failed** agent sessions (`activity.kind === 'failed'`)
     as a fourth status so crashes stop vanishing; "Stop" becomes "Dismiss" for
     them (disposes the retained session).
2. **`SessionsPopover` row** (`WorkspaceTopBar.tsx`): earned dot only —
   - `needs-input`: warn `StatusDot` with pulse, meta "waiting 4m".
   - `working`: good `StatusDot`, meta "active 12m" (since `activity.since`).
   - `failed`: error `StatusDot`, no pulse, meta "exit 1 · 8m ago".
   - `idle`: **no dot**; muted meta "idle · 12m" from `activity.since`.
   - Relative times via `useRelativeNow(30_000)` + `formatRelativeMsAgo`,
     `tabular-nums`, full timestamp in `title`/`aria-label`.
3. **Sort rows within each workspace group**: needs-input → failed → working →
   idle (idle by most-recent activity).
4. **Trigger badge**: keep the count, but color it `tone-warn` when any session
   is `needs-input` (and `tone-error` when any failed); today it is always
   `tone-good`, which repeats the lie in miniature.
5. **`getTerminalSessionsSignature`**: include `activity.since` (and failed
   retention) so memoized session items refresh on transitions the UI now
   renders.

State matrix (session manager row):

| State | Glyph | Label/meta | Primary action | Recovery |
| --- | --- | --- | --- | --- |
| needs-input | warn dot, pulse | "Needs input · waiting 4m" | Open (focus terminal) | answering clears via MCP/state |
| working | good dot | "Working · 2m" | Open | — |
| idle | none | "idle · 18m" | Open | Stop available |
| failed | error dot | "exit 1 · 8m ago" | Open (replay visible) | Dismiss |

Tests: extend `workspaceManagerHelpers` coverage (status derivation incl.
failed retention and sorting) in the existing node test harness.

**Limitation Phase 1 ships with, stated honestly:** needs-input is still
Sprint-Engine-only, and "working" still means "produced output in the last
4 s". Phase 1 makes the UI faithful to the signal; Phases 2–3 make the signal
faithful to reality.

## Phase 2 — Honest generic signals (main process, CLI-agnostic)

Goal: detect *needs input* and *confirmed working* for any CLI from the byte
stream, manifest-driven.

1. **Stream scanner per agent session** in `terminal-runtime.ts`'s `onData`
   path: maintain an ANSI-stripped rolling tail (reuse the strip logic family
   in `src/renderer/src/components/workspace/guidedBrief/parseStream.ts` /
   `stripAnsiAndOverwrites`, lifted to shared), and extract:
   - **BEL** (`\x07` outside OSC terminators) → `lastBellAt`. Claude Code can
     ring the terminal bell when it needs attention
     (`preferredNotifChannel: terminal_bell`); other CLIs ring it natively.
     *(Verify per CLI at implementation.)*
   - **OSC 0/2 window-title** payloads → `lastTitle`. Claude Code publishes a
     busy/idle indicator in the title. *(Verify exact format empirically.)*
2. **Manifest `activitySignals` block** (new, optional) on CLI plugin
   manifests (`src/shared/plugin-manifest.ts` + validation):
   ```jsonc
   "activitySignals": {
     "workingPatterns":    ["esc to interrupt"],
     "needsInputPatterns": [{ "pattern": "Do you want to", "reason": "permission" }],
     "idlePromptPatterns": ["? for shortcuts"]
   }
   ```
   Evaluated against the rendered tail. Bundled `claude-code` and `codex`
   manifests seed real patterns; user-defined CLIs add their own — same
   pluggability story as `permissionPresets` / `modelSelection`.
3. **Attention reducer** (new module, e.g. `src/main/agent-attention.ts`, pure
   + unit-tested like `agent-stream-watcher.ts`): merges pattern matches, bell,
   title, and output recency into the snapshot's new `attention` field with
   explicit demotion rules:
   - a `needs-input` pattern match is cleared by subsequent user input
     (`lastInputAt > matchAt`) or by new working evidence;
   - a `working` pattern match outlives the 4 s output gap (fixes false idle);
   - bell alone = attention ping that decays after the next output burst.
   Broadcast only on attention transitions (same discipline as today).
4. **Known hard problem, called out:** pattern matches describe *what was
   printed*, not *what is on screen now*. Mitigations, in order: evaluate only
   the post-clear-sequence tail; demotion rules above; and if that proves too
   flaky in practice, the fallback design is a headless terminal grid per agent
   session (e.g. `@xterm/headless` in main) so patterns query the actual screen
   state. Start with the tail heuristic; keep the grid as a measured escape
   hatch, not a default cost.
5. Renderer: `getSessionItems` consumes `snapshot.attention` when present,
   keeping Sprint Engine MCP `needs_input` as the higher tier. Workspace
   sidebar / tab dots (`deriveWorkspaceDisplayActivity`) inherit the better
   signal for free since they read the same snapshots.

## Phase 3 — Ground truth per CLI (adapter events)

Goal: stop inferring from pixels; let the CLI tell us.

1. **Claude Code, preferred path — hooks.** We already control the session id
   (`--session-id {{sessionId}}` in `resources/plugins/claude-code/plugin.json`).
   Inject a managed settings layer at launch (`terminal-launch.ts` already
   composes shims, env, and MCP config) with hooks that append one JSON line
   per event to `.multi-code/agent-activity/<sessionId>.jsonl` (or an
   app-userData path):
   - `UserPromptSubmit` → working (turn started)
   - `PreToolUse` / `PostToolUse` → working heartbeat
   - `Notification` → needs-input (permission request / idle prompt)
   - `Stop` / `SubagentStop` → idle (turn finished)
   Main watches the file and feeds the attention reducer as the top tier.
   *(Verify at implementation: `--settings` layering semantics, hook event
   names/payloads for the installed CLI version, and interplay with user-owned
   hook config — the managed layer must add, not clobber.)*
2. **Claude Code, fallback path — transcript watch.** Because the session id is
   caller-set, the transcript JSONL under `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
   is locatable without any CLI config change; its tail yields turn boundaries
   and last-event timestamps. Less precise (no notification events) but
   zero-footprint.
3. **Codex — `notify` hook.** Codex supports a `notify` program invoked on
   events such as `agent-turn-complete` (config override injectable at launch,
   e.g. `-c notify=[...]`). Same JSONL append target. *(Verify flag shape and
   event coverage for the installed codex version.)*
4. **opencode / custom CLIs** declare the same manifest block when they have an
   event surface; otherwise they ride Phase 2 signals. Manifest shape:
   ```jsonc
   "activitySignals": {
     "adapter": { "type": "claude-code-hooks" | "codex-notify" | "transcript-file", ... }
   }
   ```
5. **Staleness decay:** if adapter events stop while PTY output continues, the
   reducer falls back a tier instead of trusting a dead feed.

## Out of scope (explicitly)

- Process-tree / CPU sampling per PTY (platform-specific, heavy; revisit only
  if adapter + pattern tiers prove insufficient).
- Changing Sprint Engine's MCP-driven `needs_input` flow.
- Conversation-runtime agents (`AgentChatView`) — they already have canonical
  turn events and truthful state.

## Verification

- Unit: attention reducer + helper derivation tests (existing node/esbuild
  harness; `terminal-session.test.ts` / `terminal-runtime.test.ts` patterns).
- Electron verify harness (playwright `_electron`, temp
  `MULTICODE_USER_DATA_DIR` profile): spawn a real session, assert popover
  states/dots/relative times across working → idle → needs-input transitions.
- Manual ground truth: a real Claude Code session driven through a permission
  prompt, a long silent tool call, and a finished turn — the three cases the
  current system gets wrong.

## Open questions for review

1. **Failed/exited rows:** Phase 1 proposes showing retained *failed* sessions
   in the session manager. Should cleanly *exited* recent sessions appear too
   (e.g. "finished 10m ago", auto-pruned), or live sessions + failures only?
2. **Working glyph idiom:** keep the 6 px `StatusDot` for working, or adopt the
   `LifecycleGlyph` accent spinner used by Backlog/Sprint Engine worklists for
   "alive right now"? (One idiom per surface; the popover currently uses dots.)
3. **Hooks injection comfort:** Phase 3's managed Claude Code settings layer is
   user-visible (an extra `--settings` arg / hook entries). Acceptable, or
   should the transcript-watch fallback be the default and hooks opt-in?
4. **Phase ordering:** Phase 1 can ship alone immediately. Is Phase 2 wanted
   before Phase 3, or is Claude-Code-only ground truth (3.1) more valuable than
   generic patterns and worth pulling forward?
