# Sprint Engine Event-Driven Dispatch Performance Assessment

Date: 2026-06-14

## Scope

This report re-checks whether Sprint Engine's direct/event-driven dispatch
direction is likely to improve Multicode application performance, using the
current codebase rather than the earlier 2026-06-12/13 assumptions.

The review focused on:

- Sprint Engine projection sync and projection IPC.
- Sprint Engine auto-run supervision and dispatch planning.
- Terminal rendering, replay, output fan-out, and diagnostics overhead.
- The older Workstream B performance diagnosis in
  `docs/performance/sprintengine-perf-workstream-b.md`.
- Sprint Engine Knowledge Graph notes in `knowledge/multicode/sprint-engine.md`
  and `knowledge/multicode/agent-runtime.md`.

No live Electron profile was captured for this report. Findings below are based
on source inspection plus targeted unit checks.

## Summary Judgment

Event-driven dispatch is still the right architectural direction for liveness,
correctness, and background efficiency, but it is not the primary explanation
for the worst UI performance symptoms by itself.

The current code has already removed a major earlier bottleneck: unchanged
projection polls no longer read, parse, stringify, or send full
`projection.json` payloads through the renderer. They now short-circuit with a
main-process file token check. That means "renderer parses JSON every tick" is
no longer a current finding.

The remaining dispatch-side cost is the renderer-owned auto-run supervisor:
active workspaces still tick every 4 seconds, list terminal sessions, derive
running/idle capacity, run the unified planner, and execute terminal side
effects. An event-triggered supervisor could reduce idle/background work and
latency after mutations, but it will not remove the need for Multicode to own
terminal wake-up unless Codex/Claude MCP notification wake-up is proven.

If the app is still laggy during large Sprint Engine runs, the most likely
remaining causes are terminal count, retained/replayed terminal output, visible
hidden terminals, PTY output fan-out, React commit breadth, or main/renderer CPU
from active terminal streams. The current Diagnostics panel is now the best
first tool for confirming which of those is real.

## Current-Code Findings

### 1. Projection Polling Is Much Cheaper Than Before

Severity: medium, confidence: high.

Current behavior:

- `SprintEngineProjectionSupervisor` still polls active Sprint Engine
  workspaces every 4 seconds and inactive workspaces every 15 seconds.
- The poll now passes a per-workspace `mtimeMs:size` token to
  `refreshSprintEngineWorkspaceProjection`.
- `src/main/sprintengine-artifacts.ts` handles `readProjection` by `stat`ing
  `projection.json`. If the caller's `knownToken` matches, it returns
  `{ unchanged: true, data: null }` without reading the file, parsing JSON, or
  sending the projection payload.
- Only changed projections are normalized in the renderer and written to
  `workspace.sprintEngineState`.

Evidence:

- `src/renderer/src/components/workspace/SprintEngineProjectionSupervisor.tsx`
- `src/renderer/src/utils/sprintengineProjectionRefresh.ts`
- `src/main/sprintengine-artifacts.ts`
- `src/shared/electron-api.ts`
- Passing check: `npm run test:renderer:sprintengine-projection-refresh`

Impact:

The previous concern that every idle poll incurred O(projection size)
renderer-side `JSON.stringify`/normalization is obsolete. Projection polling can
still matter at high workspace counts, but an unchanged run now costs mostly one
IPC call plus a main-process `stat`.

Recommendation:

Do not prioritize a projection-only event rewrite unless profiling shows the
remaining `stat`/IPC cadence is material. If event-driven sync is implemented,
keep the token-based reader as the fallback and dedupe mechanism.

### 2. Auto-Run Supervision Is Still Timer-Driven And Renderer-Owned

Severity: medium, confidence: high.

Current behavior:

- `SprintEngineAutoRunSupervisor` still runs a 4 second active poll and 15
  second inactive throttle.
- For each active workspace, it reconciles sessions, then runs a supervisor
  cycle after startup delay.
- The active cycle lists terminal sessions once, derives running/live sets and
  continuation capacity, updates the idle clock, and runs
  `runSprintEngineDispatchPaths`.
- `planSprintEngineDispatch` is a pure, unified planner for notification,
  dispatch, task wake, gate, restart, respawn, and idle-retire paths, with
  one engagement per agent per pass.

Evidence:

- `src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx`
- `src/renderer/src/utils/sprintengineAutoRun.ts`
- `src/renderer/src/utils/sprintengineAutoRunExecutor.ts`

Impact:

This is now the main dispatch-side cost to measure. It is no longer dominated
by projection JSON parsing, but it still does repeated renderer-thread work and
terminal-list IPC for active runs. Event-driven dispatch can help most by
coalescing supervisor runs around real state changes and terminal-session
changes, with the existing poll as a missed-event backstop.

Recommendation:

Move toward an event-triggered supervisor queue rather than a pure timer:

- Schedule a supervisor pass immediately after projection changed, mutation
  projection content was applied, terminal sessions changed, automation mode
  changed, or pending spawn state changed.
- Coalesce repeated triggers per workspace.
- Keep a slow recovery poll for missed file-watch or IPC events.
- Preserve the current pure planner and one-terminal-list-snapshot execution
  model.

### 3. Direct Claim Dispatch Is Primarily A Correctness And Token-Cost Win

Severity: informational, confidence: high.

Current behavior:

- Managed renderer/main prompt paths now name `sprintengine.task.next` or
  `sprintengine.gate.next` directly.
- `sprintengine.agent.next_directive` remains in Python/MCP surfaces for the
  headless CLI path, but renderer prompt tests forbid it in managed prompt
  sources.
- The direct-claim contract removes one MCP round trip per dispatch and avoids
  the renderer/server "candidate vs directive" disagreement window.

Evidence:

- `src/renderer/src/utils/sprintengineAutoRun.ts`
- `src/renderer/src/utils/agentPrompt.ts`
- `src/renderer/src/utils/sprintengineHandoff.ts`
- `tests/sprintengine_tool/test_dispatch_contract.py`
- `backlog/2026-06-12-sprintengine-direct-dispatch-architecture.md`

Impact:

This improves token use, prompt reliability, and stall recovery. It is not
expected to fix UI jank by itself. If the application is slow while agents are
streaming terminal output or workspaces are switching, the bottleneck is more
likely terminal/render work than the extra MCP dispatch hop.

Recommendation:

Keep the direct-claim architecture. Do not use it as completion evidence for
interactive performance until live profiles show lower UI-thread cost or fewer
terminal/process resources.

### 4. The Older Terminal Rebuild Findings Are Mostly Addressed

Severity: medium, confidence: high.

The older Workstream B handoff diagnosed a severe issue where each projection
update created fresh agent object identities, which caused `TerminalView`'s
xterm setup effect to tear down/replay terminals.

Current behavior:

- `TerminalView` now stores volatile launch/display inputs in refs and keeps the
  xterm setup effect dependency list to lifecycle/identity fields such as
  workspace id, agent id, session id, restart nonce, execution mode/worktree,
  folder path, and kill-on-unmount policy.
- `reconcileSprintEngineAgents` reuses unchanged agent objects and the agents
  map when reconciliation produces the same values.
- The identity behavior is covered by `runStateSlice` tests.

Evidence:

- `src/renderer/src/components/panels/TerminalView.tsx`
- `src/renderer/src/store/slices/runStateSlice.ts`
- `src/renderer/src/store/slices/runStateSlice.test.ts`
- Passing check: `npm run test:renderer:run-state-slice`

Impact:

The specific "every projection update rebuilds every xterm" finding is no
longer current. If workspace switching remains slow, measure actual
`TerminalView terminal-detached-from-renderer`, replay profile entries, React
commits, and retained terminal counts before changing dispatch architecture.

Recommendation:

Use the Diagnostics panel and React profiler before further terminal rewrites.
The next likely terminal-side improvements should be based on measured retained
replay size, hidden-but-visible terminals, and output activity, not the old B1
assumption.

### 5. Terminal Output And Diagnostics Overhead Have Improved

Severity: low to medium, confidence: high.

Current behavior:

- `terminal-output-buffer.ts` buffers terminal data and does not send
  `terminal:data:<id>` events when `session.visible === false`.
- Terminal data diagnostics now return early when diagnostics are disabled.
- `createMainDiagnostics` no longer logs perf events when diagnostics are off.
- A dev Diagnostics panel now aggregates terminal sessions, retained output,
  hidden-but-visible terminals, long-idle sessions, stale sessions, process
  metrics, and replay profile entries.

Evidence:

- `src/main/terminal-output-buffer.ts`
- `src/main/terminal-diagnostics.ts`
- `src/main/main-diagnostics.ts`
- `src/renderer/src/components/diagnostics/DiagnosticsContent.tsx`
- `src/renderer/src/utils/diagnostics/aggregateDiagnostics.ts`
- Passing checks:
  - `npm run test:renderer:diagnostics-aggregation`
  - `npm run test:main:terminal-runtime`

Impact:

Some previously suspected background costs are already reduced. Remaining
terminal overhead is more likely to come from live visible terminals, retained
workspace/xterm mounting, replay size, active streaming volume, or React commit
breadth.

Recommendation:

When a run feels slow, first capture a Diagnostics panel copy and inspect:

- Total terminals and live terminals.
- Runtime-visible terminals in hidden workspaces.
- Retained replay bytes and largest replay.
- Active vs idle terminal counts.
- Process CPU/RSS.
- Recent replay profile entries.

### 6. Auto-Run Test Drift Needs Cleanup

Severity: medium, confidence: high.

One targeted check failed:

`npm run test:renderer:sprintengine-auto-run`

The failure is in
`testAutoApprovalAppliesReturnedProjectionWithoutDiskFallback`. The test still
expects the auto-approval fast path to write the old projection JSON signature
into `lastContentByWorkspace`. Current code has renamed this state to
projection tokens and intentionally deletes the token when mutation projection
content is applied out-of-band, because it does not know the authoritative
file `mtime:size` token until the next disk read.

Evidence:

- Current implementation:
  `src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx`
  `applyAutoApprovalProjectionContent` deletes the workspace token after applying
  mutation projection content.
- Stale expectation:
  `src/renderer/src/utils/sprintengineAutoRun.test.ts` still names
  `lastContentByWorkspace` and expects `JSON.stringify(mutatedProjection)`.

Impact:

This is probably test drift from the projection-token rewrite, not a production
performance defect. It still matters because it weakens confidence in the
auto-run suite and should be fixed before using that suite as evidence for the
new projection contract.

Recommendation:

Update the test to assert the new contract:

- Applying mutation projection content avoids immediate disk fallback.
- The workspace state is updated from mutation content.
- The projection token is cleared/unknown after out-of-band application.
- The next non-forced projection refresh is allowed to read from disk and record
  the authoritative token.

## Event-Driven Dispatch: Expected Performance Value

Expected wins:

- Fewer idle/background supervisor passes.
- Lower dispatch latency after real state changes, because the app does not
  wait for the next 4 second tick.
- Less repeated terminal-list IPC when no terminal/session state changed.
- Cleaner reasoning: one planner pass triggered by state change, with the poll
  only as recovery.

Expected non-wins:

- It will not eliminate terminal output processing for active CLIs.
- It will not reduce CPU/RSS from many live agent processes unless paired with
  idle retirement, terminal lifecycle policy, or process-count changes.
- It will not fix React grid commits caused by broad subscriptions or mounted
  hidden workspaces unless those are separately measured and addressed.
- It cannot rely on MCP server notifications alone to wake Codex/Claude
  sessions. Current architecture notes still require Multicode to spawn, focus,
  or paste into terminals.

Recommended architecture:

1. Keep Sprint Engine as the state/tool authority.
2. Keep Multicode as the terminal lifecycle and wake-up owner.
3. Add an event-triggered, per-workspace supervisor scheduler in the renderer or
   a main-owned coordinator, using the existing pure planner.
4. Trigger from projection changed, mutation applied, terminal sessions changed,
   auto-run settings changed, and pending spawn transitions.
5. Coalesce triggers and keep the slow poll as a recovery mechanism.
6. Measure before and after with the Diagnostics panel, perf logs, and React
   profiler.

## Verification Performed

Passed:

- `npm run test:renderer:sprintengine-projection-refresh`
- `npm run test:renderer:run-state-slice`
- `npm run test:renderer:diagnostics-aggregation`
- `npm run test:main:terminal-runtime`

Failed:

- `npm run test:renderer:sprintengine-auto-run`
  - Failure appears to be stale test expectation around the old projection
    JSON signature cache, superseded by the current `mtime:size` token contract.

Not performed:

- No live Electron profile.
- No React DevTools profile.
- No long-running supervised Sprint Engine run with 20-40 live terminals.

## Recommended Measurement Plan

For the next performance pass, collect these before changing architecture:

- Diagnostics panel copy during a slow run.
- Renderer console events for:
  - `SprintEngineProjection refresh`
  - `SprintEngineAutoRun tick-end`
  - `SprintEngineAutoRun running-agents-end`
  - `TerminalView terminal-detached-from-renderer`
  - `TerminalView terminal-replay-profile`
- Main-process diagnostics for terminal replay/spawn/reattach and slow IPC.
- React profiler around workspace switching and a busy terminal grid.

The decision rule:

- If `SprintEngineAutoRun tick-end` and terminal-list IPC dominate idle time,
  prioritize event-triggered supervisor scheduling.
- If terminal counts, retained replay, hidden-but-visible rows, or React commits
  dominate, prioritize terminal/workspace retention work before dispatch
  architecture.
- If CPU/RSS is dominated by live CLIs, prioritize idle retirement policy,
  agent capacity, and process lifecycle rather than renderer dispatch.

