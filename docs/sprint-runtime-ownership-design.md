# Sprint Runtime Ownership — Design

Working design for the `sprint-runtime-ownership` epic: move the sprint auto-run
loop and automation state out of the renderer into an always-on main-process
`SprintRuntime` service, making the renderer a subscriber/controller and enabling
remote control, lock-screen survival, and (Phase 3) true headless auto-run.

This document is the architecture record for all three phases. It is written
against the code as of `main@22991255`.

## Ground truth (verified, not assumed)

- The pure automation reducer (`transitionSprintEngineAutomation`) and every
  derivation helper import **only types**; the planner corpus
  (`sprintengineAutoRun.ts`, 2.1k lines) has exactly one impure import
  (`logPerfEvent`). Relocation is mechanical, not a rewrite.
- `tsconfig.node.json` already compiles `src/renderer/src/types/workspace.ts`
  into the main project, so main can already type-import the automation types.
  (We still relocate the portable subset to `src/shared/` so the dependency
  points the right way long-term.)
- Agent PTYs already live in main (`terminal-runtime.ts`); the renderer only
  requests spawns over `terminal:spawn` and hosts xterm views.
- The mobile snapshot (`snapshot.ts buildAutomationMode`) already prefers an
  explicit `automation.desiredMode` read from the run's folder store and falls
  back to the lossy `runner.cliWatchPolling` heuristic. Phase 1 slots into a
  read path that already exists.
- MC-1497's executor chain is complete but the desktop adapter
  (`setSprintEngineAutomationMode`) is never wired, so every call rejects with
  `command_not_supported` ("requires the desktop app to be open") from
  `src/main/mobile/sprintengine/session.ts`.
- `backgroundThrottling` and `powerSaveBlocker` appear nowhere in `src/` — the
  lock-screen stall is real and unmitigated.
- run.yaml and projection.json are written **only by the Python engine**
  (Electron mutates via CLI). The one sanctioned app-owned writer inside the
  team dir is `metrics/token-usage.jsonl` (main). This constrains where the
  authoritative automation intent may persist.

## Cross-phase principles

1. **One authoritative store per fact, owned by main.** The renderer may hold a
   mirror for display and optimistic UI, but reconciles against main's value
   and never re-asserts a stale one (guarded by a monotonic revision on the
   authoritative store, mirroring the mobile `snapshotVersion` guard).
2. **Engine boundary respected.** The app never writes `run.yaml` or
   `projection.json`. The automation intent persists in an **app-owned sidecar
   file** in the team directory: `automation.json` beside `run.yaml` (same
   precedent as `metrics/token-usage.jsonl` — app-owned state the engine
   neither reads nor validates). The mobile snapshot reads it directly and
   feeds `buildAutomationMode` its `desiredMode`.
3. **Pure logic in `src/shared/sprintengine/`,** imported by main, renderer,
   and tests. No electron, no `window`, no `src/main` imports. Impure seams
   (clock, perf log, audit sink, terminal ops) are injected ports.
4. **Single writer path.** Desktop UI, phone, and any future CLI all converge
   on the main-process `setAutomationMode` service call; audit is emitted in
   main so parity is structural, not disciplinary.
5. **No runtime behavior flags** (project policy, overriding the epic's
   rollout sketch): the Sprint Engine lands policy changes directly in small
   revertible commits — safety comes from pre-release validation, never
   dual-path toggles. Phase 2 therefore moves scheduling to main outright in
   its own commit (the renderer supervisor keeps only its reconcile/view role
   until Phase 3 deletes it); there is no shadow mode, no `schedulerOwner`
   toggle, and the end state is a single owner. Each phase commit is
   independently revertible.

## Persistence: `automation.json` (Phase 1, extended in later phases)

Location: `<teamDirectory>/automation.json` (beside `run.yaml`). Owned and
written only by Electron main (atomic write: tmp + rename). Run stores are
ignored local runtime state (`docs/sprintengine-runtime-state-policy.md`), and
the token ledger sets the precedent for app-owned files inside the team dir
that the engine neither reads nor validates.

**Phase 1 persists only the mode intent** — the backlog item explicitly allows
runtime-derived fields (`runtimeState`, `pendingSpawns`,
`completionTeardownAt`) to stay renderer-derived while the loop is still
renderer-driven, and the mobile snapshot only surfaces `desiredMode`. Keeping
the intent record minimal removes the renderer→main lifecycle-event chatter
and the torn-state risk the item flags. Schema v1:

```jsonc
{
  "schemaVersion": 1,
  // monotonic revision; every main-side write bumps it. Broadcasts carry it;
  // the renderer ignores any broadcast older than the last one it applied and
  // never re-asserts local state over a newer revision.
  "revision": 42,
  "desiredMode": "run_agents",   // manual | run_agents | run_agents_and_approve_artifacts
  "changedAt": 1789000000000,
  // provenance of the last write, for audit parity + debugging
  "lastWrite": { "actor": "ui", "deviceId": null, "at": "ISO" }  // actor: ui | mobile | system
}
```

The renderer keeps running its reducer locally for runtime lifecycle
(`runtimeState`, reasons, `pendingSpawns`, `completionTeardownAt`,
`deliveredAgentNotificationEventKeys`, `architectGuidance`). A mode change —
from any writer — reaches the renderer as an authoritative broadcast and is
applied through the same `user_set_mode` reducer transition it uses today, so
runtime state follows exactly as it does now. Phase 2 extends this file with
scheduler-owned state (`schedulerOwner`, pending spawns, delivered keys) when
main takes the loop.

## Phase 1 — Automation mode ownership → main

New modules:

- `src/shared/sprintengine/automation-types.ts` — relocated portable types
  (`SprintEngineAutomationMode`, `DesiredMode`, `RuntimeState`, `StopReason`,
  `AutomationEvent`, `AutoPendingSpawn`, `CliPermissionPreset`, the
  mode-intent state shape). `src/renderer/src/types/workspace.ts` re-exports
  them (type aliases) so no renderer import site changes.
- `src/shared/sprintengine/automation-lifecycle.ts` — relocated pure reducer +
  helpers, verbatim; renderer `sprintengineAutomationLifecycle.ts` becomes a
  re-export shim (same pattern as `sprintengineAutoRunPlanner.ts`).
- `src/shared/sprintengine/automation-store.ts` — pure serialize/normalize of
  `automation.json` (schema guard, revision math). No fs.
- `src/main/sprintengine-automation-service.ts` — the owner:
  - `readAutomationMode(statePath)` → reads `automation.json` (null when the
    sidecar doesn't exist yet).
  - `setAutomationMode({ statePath, mode, actor, reason?, details?, workspaceId?, workspaceName? })`
    → validates the mode, bumps revision, atomic-writes the sidecar, writes
    the manual-transition audit (main `writeDiagnosticLog`, identical record
    shape to the renderer audit; only on non-manual → manual, matching
    today's semantics), bridges `cliWatchPolling` via the existing
    `setRunnerMode` CLI path (best-effort, warn-only failure — same semantics
    as the board panel today), broadcasts `sprintengine:automation-changed`
    to all windows, and returns the new record.
  - `hydrateAutomationMode({ statePath, mode })` → seeds the sidecar from the
    legacy renderer value **only when no sidecar exists** (one-time
    migration; no audit, actor `system`, no cliWatchPolling bridge — the
    on-disk hint already reflects the old UI's writes).
- `src/main/ipc/sprintengine-automation-ipc.ts` — `sprintengine:automation:*`
  channels (`read`, `set-mode`, `hydrate`), registered in
  `register-core-ipc.ts`; preload `src/preload/api/sprintengine-automation.ts`.

Rewires:

- Renderer `setSprintEngineAutomationMode` store action: still runs the local
  reducer transition synchronously (same optimistic UX as today), then
  dispatches the main write (fire-and-forget from the store's perspective; a
  dedicated client owns the IPC). The manual-mode audit emission moves to
  main — the renderer stops calling `auditSprintEngineManualModeTransition`
  from this action so there is exactly one audit per transition regardless of
  writer. `applySprintEngineAutomationEvent` (runner lifecycle) is untouched
  in Phase 1.
- The board panel stops calling `window.api.setSprintEngineRunnerMode`
  directly — the cliWatchPolling bridge lives in the one main write path.
- Broadcast subscription: a small renderer module subscribes to
  `sprintengine:automation-changed` and applies `user_set_mode` into the
  store keyed by statePath→workspace, tracking the last-applied revision per
  statePath (skips stale/duplicate revisions and no-ops; never re-dispatches
  to main — the no-echo rule from workspace-sync).
- MC-1497: `terminal-runtime.ts createMobileCommandService` wires
  `setSprintEngineAutomationMode` to the main service (statePath-first, no
  renderer round-trip; works headless). The session-layer "requires desktop"
  rejection disappears structurally.
- Mobile snapshot: `readSprintEngineSnapshot` also reads `automation.json` and
  passes `automation.desiredMode` into `buildAutomationMode` ahead of the
  `run.automation`/`cliWatchPolling` fallbacks — the exact three-state value.
- One-time hydration: on renderer boot (or first read of a workspace with a
  legacy `sprintEngineAutoState`), the renderer pushes its persisted value via
  `sprintengine:automation:hydrate`; main accepts it only when the sidecar
  does not yet exist. In-flight runs migrate cleanly; headless reads before
  hydration fall back to the `cliWatchPolling` heuristic exactly as today (no
  regression).

Audit parity: main emits the same diagnostics record (`source: 'sprintengine'`,
same title/message/details shape) via `writeDiagnosticLog` for every
manual-mode transition regardless of writer (UI, phone, future CLI), with the
actor recorded in `details`.

Tests (node --test / esbuild-node pattern, added to `verify:app`):
- `test:shared:sprintengine-automation-lifecycle` — relocated reducer suite
  (existing renderer test moves with the code; shim keeps old imports green).
- `test:shared:sprintengine-automation-store` — serialize/normalize/revision.
- `test:main:sprintengine-automation-service` — real-tmpdir service tests:
  set-mode transitions, audit emission, revision conflict, hydrate-once,
  cliWatchPolling bridge (fake CLI port), broadcast port called.
- `test:main:mobile-sprintengine-command` — extend: setAutomationMode now
  succeeds headless via the service (no orchestrator adapter), stale-snapshot
  guard still enforced.
- `test:main:mobile-sprintengine-snapshot` — extend: `automation.json`
  desiredMode surfaces exactly, including approve-artifacts variant.
- Renderer: run-state-slice tests updated for the rewired action (optimistic +
  reconcile), board dormancy source-contract test kept green.

## Phase 2 — Scheduler loop → main (`SprintRuntime`)

Enabling facts from the terminal-runtime map:
- Main already spawns sprint agents without the renderer: the mobile
  `task.start` path (`spawnMobileAgentTerminal`, `terminal-runtime.ts`)
  resolves launch config, identity env, MCP sync, and PTY spawn entirely
  main-side. Phase 2's executor generalizes that path rather than inventing
  one.
- The planner corpus is pure except `logPerfEvent`; the projection read +
  normalization helpers (`sprintengine.ts`) are pure with type-only imports.
- The renderer supervisor's per-tick inputs are: automation state (Phase 1:
  main-owned intent + renderer runtime state), the normalized projection,
  roster/agent records, terminal session list (already main's data), and
  `appSettings.cliRuntimes` / `appSettings.mcp` (renderer-persisted — must be
  pushed to main or read through the existing mobile-command config seam).

Core moves:
- Relocate the pure planner corpus (`sprintengineAutoRun.ts` + the pure
  helpers it needs from `sprintengine.ts` / `sprintengineInitialSpawns.ts`,
  and the normalization utilities the projection read needs) to
  `src/shared/sprintengine/` with `logPerfEvent` injected as a port (no-op in
  main by default, existing perf log in renderer). Renderer files become
  re-export shims (the established `sprintengineAutoRunPlanner.ts` pattern);
  the 6.4k-line planner suite runs unchanged.
- `src/main/sprint-runtime.ts` — per-active-run scheduler:
  - Registry keyed by statePath; a run is *active* when the Phase 1 intent
    says non-manual and the run is not complete.
  - `setInterval` cadence in main (immune to occlusion throttling), with
    immediate wake on automation-mode writes and relay commands; idle
    workspaces tick at the slower cadence exactly as the renderer poller does
    today (4s active / 15s inactive equivalents).
  - Each tick: read projection main-side (token-gated stat fingerprint, same
    as `readProjection`) → normalize (shared) → plan (shared planner) →
    execute via main-side ports: in-process terminal runtime for
    spawn/paste/kill/status, `writeDiagnosticLog` for diagnostics, the
    Phase 1 automation service for mode/lifecycle writes.
  - Idle retirement, retry ledgers, completion detection, `stopWhenComplete`,
    and pending-spawn bookkeeping move into the runtime (per-run in-memory
    ledgers mirroring the supervisor's refs; pending spawns persisted to the
    automation sidecar so a restart reconciles cleanly).
- Power: `powerSaveBlocker.start('prevent-app-suspension')` while ≥1 run is
  actively auto-running; released when the last run goes idle/complete/manual
  and on shutdown (release path tested). `backgroundThrottling: false` on the
  workspace windows so the renderer view stays live when occluded.
- Single owner, no flag (see cross-phase principle 5): Phase 2's commit moves
  scheduling to main outright. The renderer supervisor keeps only its
  session-reconcile phase; there is exactly one scheduler per run at all
  times.
- The main↔renderer bridge (`src/shared/sprintengine/runtime-bridge.ts`):
  the renderer registers run contexts (identity + run config; runtime residue
  adopted on first registration only) and pushes renderer-originated stops;
  main broadcasts every cycle store-op on `sprintengine:runtime-op`, applied
  by `sprintengineRuntimeBridge.ts` with the same no-echo discipline as the
  Phase 1 mode sync. Launch settings mirror through
  `sprintengine:launch-settings:sync` into a userData-persisted store so main
  spawns with the renderer's configured runtimes headlessly.

## Phase 3 — Session model → main; renderer pure view

Enabling facts: the PTY registry, scrollback buffers, suspend sidecars,
reaping, resume-capability stamping, and the app-quit snapshot dump are all
already main-owned; the renderer's "session model" is launch flags on
`AgentState` + a subscribed `TerminalSessionSnapshot` mirror; a window close
already leaves PTYs alive (views go `setVisible(false)`, reattach exists in
`spawnTerminalFromIpc`).

Moves:
- Promote main to the source of truth for agent-session lifecycle: the
  renderer's launch flags become a projection of main session state
  (`reconcileWorkspaceAgentLaunchFlags` already does this on sync — it becomes
  the *only* writer of those flags for sprint agents; renderer-side
  `applyAgentTerminalSessionEvent` stays for the sync-bus contract).
- Roster session records (`sprintEngineRosterSessions` — resume tokens per
  roster agent) get a main-owned mirror in the automation sidecar so headless
  respawn/resume works with no renderer store.
- Attach/detach: formalize what exists — xterm views attach by sessionId with
  replay; window close detaches; reopen reattaches with scrollback (replay
  snapshot machinery unchanged).
- Retire `SprintEngineAutoRunSupervisor.tsx` + the renderer executor;
  completion teardown (`tearDownCompletedSprintRunAgents` equivalent) and the
  one-shot `completionTeardownAt` guard move into `SprintRuntime`, persisted
  in the sidecar.
- App quit: keep today's semantics (dispose PTYs with sidecar snapshots,
  resumable on relaunch) — quit ends the run's *live* agents but not the run;
  window close no longer affects the run at all. Recorded as the lifecycle
  decision the backlog item asks for.

## Verification bar

Matches the epic: reducer/planner/scheduler pure tests under node; integration
tests headless (no window) for MC-1497 → sidecar → snapshot; end-to-end on a
running app per phase (UI + phone mode set, lock-screen progression at Phase 2,
window-closed progression at Phase 3); no regression to the existing supervisor
suites until the renderer owner is retired.
