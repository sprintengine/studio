# Main Process FD / PTY Resource Profile

Date: 2026-06-14

Scope: Multicode live dev instance under `electron-vite dev`, focused on the main Electron process resource profile: file descriptors, threads, terminal PTYs, and file watchers. This report intentionally does not re-diagnose the renderer/GPU CPU and memory issues except where current source review changes the interpretation of the original profile.

## Executive Summary

The original "248 FDs" warning was directionally useful but too imprecise: `lsof` row count is not the same as open file descriptor count. In the current live app, the main process shows `367` `lsof` rows, but `286` actual numeric file descriptors. That is still high, and the inventory is clearly terminal-heavy: `96` `/dev/ptmx` descriptors, `42` `/dev/ttys*` descriptors, and `67` kqueues.

The main risk is not ordinary filesystem watching. The dominant scaling factor is terminal/PTY lifecycle behavior. Current source still attaches `node-pty` `onData` / `onExit` handlers without storing their disposables, deletes terminal sessions before killing their PTY, and allows a late buffered output flush to send when `getSession(sessionId)` returns `undefined`.

An isolated `node-pty` probe using the current dependency reproduced retained PTY-related descriptors after terminal kill and GC. Five spawned ptys raised the probe process from `17` to `38` numeric FDs; after `kill()` and forced GC it remained at `33`, retaining five `/dev/ptmx` descriptors and five kqueues. That strongly suggests descriptor pressure will scale with terminal churn unless the lifecycle is explicitly tightened or the dependency behavior is changed.

## Plain English Version

There are two separate things being counted:

1. `lsof` rows are everything `lsof` can report about the process, including loaded code mappings like `txt`. They are useful, but they are not all open file descriptors. The current app had `367` rows but `286` actual numbered descriptors.

2. Each terminal tab is not free. It creates OS-level PTY resources in the main process. When many terminal tabs and agent terminals are open, those PTY handles dominate the main process descriptor count. In the current sample, terminal-related descriptors are the headline item.

## Current Live Measurement

Live context at measurement time:

- Main process PID: `67989`
- Renderer PID: `67996`
- GPU PID: `67993`
- Network utility PID: `67994`
- Direct `/bin/zsh` children: `37`
- Main process thread count: `85`
- Dev shell `ulimit -n`: `1048575`
- `launchctl limit maxfiles`: soft `256`, hard `unlimited`
- `kern.maxfilesperproc`: `61440`

Main-process `lsof` inventory for PID `67989`:

| Metric | Count |
| --- | ---: |
| Total `lsof` rows | 367 |
| Numeric FD rows | 286 |
| Unique numeric FDs | 286 |
| Non-numeric rows | 81 |
| `/dev/ptmx` | 96 |
| `/dev/ttys*` | 42 |
| KQUEUE | 67 |
| Unix sockets | 6 |
| Pipes | 8 |
| Regular files | 37 |
| Character devices | 139 |

Non-numeric rows were mostly `txt` mappings (`80`) plus `cwd` (`1`). These rows should not be treated as open file descriptors for `EMFILE` risk accounting.

The descriptor count is higher than the earlier `35170` sample, but the workload is also heavier: this live app had many terminal shells and agent descendants. This still validates the scaling concern because the growth is concentrated in PTY descriptors.

## Current Codebase Review

### Terminal Replay Is Now Bounded

`src/main/terminal-session.ts` currently tracks output in `outputChunks`, `outputChunkBytes`, and `outputChunkStart`, then trims retained replay through `getTerminalReplayLimitBytes`. Snapshot data exposes `retainedOutputBytes` and `replayLimitBytes` for diagnostics.

This means the older broad hypothesis of "unbounded replay buffers" should be narrowed. Replay retention can still be expensive with many busy terminals, but current source does show bounded replay behavior.

### Renderer JSON Parsing Is Not Included As A Current Finding

The renderer still has some `JSON.parse` callsites around SprintEngine projection content, for example:

- `src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx`
- `src/renderer/src/components/panels/sprintEngineBoard/useSprintEngineBoardArtifactActions.ts`

The reviewed callsites are tied to projection content from mutation or roster operations, not enough evidence by themselves to keep the older "JSON parse every tick" concern in this report. That should be validated separately with a renderer CPU profile if it remains suspected.

### Terminal Lifecycle Still Has Cleanup Gaps

Relevant source:

- `src/main/terminal-runtime.ts`
- `src/main/terminal-session.ts`
- `src/main/terminal-output-buffer.ts`

Current behavior:

- `attachTerminalSession` calls `terminalSession.process.onData(...)` and `terminalSession.process.onExit(...)` without storing the returned disposables.
- `TerminalSession` has no fields for those listener disposables.
- `disposeTerminal` marks the session disposed, deletes it from `terminals`, broadcasts, then calls `session.process.kill()`.
- `terminal-output-buffer.ts` flushes when `session?.visible !== false`; if `getSession(sessionId)` returns `undefined`, that expression still evaluates true and sends the late buffered batch.

Impact:

- A disposed terminal can still have late callbacks racing after the session is removed.
- Listener disposal is not explicit, so teardown depends on `node-pty` and V8 cleanup behavior.
- Late output batches can still cross IPC after the main session record is gone.
- The current code does not provide a single terminal teardown primitive that can be audited for PTY, listener, timer, output-buffer, diagnostic, heartbeat, and SprintEngine lifecycle cleanup.

### `node-pty` Probe Reproduces Retained Descriptors

Dependency: `node-pty` `1.1.0`.

Probe result in an isolated Node process:

| Step | Numeric FDs | `/dev/ptmx` | `/dev/ttys*` | KQUEUE |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 17 | 0 | 0 | 4 |
| After spawning 5 ptys | 38 | 10 | 5 | 9 |
| After `kill()` | 33 | 5 | 0 | 9 |
| After forced GC | 33 | 5 | 0 | 9 |

This does not prove Multicode is leaking every PTY in production flow, but it does prove the current dependency/runtime combination can retain PTY-related descriptors after simple `kill()` cleanup. That is enough to justify adding teardown tests and a dependency-level investigation before dismissing FD growth as expected terminal cost.

### Filesystem Watchers Are A Secondary Risk

Relevant source: `src/main/ipc/filesystem-watch-search-ipc.ts`.

Current behavior:

- `fileWatchers` is keyed by generated watch ID.
- There is no dedupe/refcount by normalized path and recursive mode.
- `event.sender.once('destroyed', ...)` is registered before `await deps.pathExists(dirPath)`.
- There is no `event.sender.isDestroyed()` recheck after the await and before `watch(...)`.

Impact:

- Multiple panels can create duplicate watchers for the same path.
- If a sender is destroyed during the async `pathExists` window, cleanup can run before the watcher exists, then a watcher can be created with no living owner.

This is lower priority than PTY lifecycle because the live FD inventory is PTY-dominated, but it is still a real orphan-resource race.

### Diagnostics Surface Still Has A Gap

`src/main/process-metrics.ts` now collects Electron app process metrics for CPU and memory. The code explicitly omits `threads` and `fileDescriptors` in the MVP. The diagnostics UI has table columns for those values, but they show unavailable data.

That is acceptable for a lightweight diagnostics panel, but it means this class of main-process resource pressure still requires external tools (`lsof`, `ps -M`, `top`, `footprint`) to observe. If FD/thread pressure remains a recurring issue, add opt-in diagnostics rather than polling `lsof` continuously.

## Findings

### Medium: Descriptor Pressure Is Real, But The Original Count Was Overstated

Evidence:

- Current live `lsof`: `367` total rows, `286` numeric descriptors.
- Earlier `248 FDs` language likely counted `lsof` rows, not just numeric descriptors.
- Current live app has a high terminal count, so it is not an idle baseline.

Impact:

- The app is not immediately proven to be near `EMFILE` in the current dev-shell launch context.
- The descriptor count still scales with open terminals and can become a real ceiling in packaged launches or shells that inherit a lower `NOFILE` limit.

Recommended action:

- Use numeric FD count, not raw `lsof` row count, in future reports.
- Capture effective launch limits for packaged app startup separately.

### Medium-High: PTY Lifecycle Is The Dominant Main-Process Resource Risk

Evidence:

- Live inventory: `96` `/dev/ptmx`, `42` `/dev/ttys*`, `67` kqueues.
- Current direct children include many terminal shells.
- Isolated `node-pty` probe retained five `/dev/ptmx` descriptors and five kqueues after killing five ptys and forcing GC.

Impact:

- Heavy terminal churn can increase descriptors even after visible terminal count drops.
- If retained handles accumulate, long-running dev sessions can drift upward until they hit a launch-specific descriptor ceiling.

Recommended action:

- Add a focused terminal lifecycle test/probe that creates, disposes, and recounts PTY descriptors in a separate process.
- Investigate whether a `node-pty` upgrade, alternate lifecycle call, or upstream patch closes the retained descriptors.
- Avoid private FD closing until proven safe; the retained descriptor in the probe is not the public `term.fd`.

### Medium: Terminal Runtime Teardown Should Be Made Explicit

Evidence:

- Listener disposables are not stored on `TerminalSession`.
- `disposeTerminal` deletes the session before PTY kill completes.
- Output buffer sends late data for missing sessions because `session?.visible !== false` is true when `session` is undefined.

Impact:

- Late events after disposal are harder to reason about.
- Resource cleanup is spread across several code paths.
- Diagnostics can under-report the session that caused the resource use once it has been removed from `terminals`.

Recommended action:

- Store `onData` and `onExit` disposables on `TerminalSession`.
- Introduce a single internal teardown helper that clears idle timers, heartbeat timers, output buffers, diagnostics, listeners, and startup scripts before removing the session.
- Guard `onData` with `terminals.get(sessionId) === terminalSession && !terminalSession.isDisposed`.
- Change output-buffer flush to skip sends when `getSession(sessionId)` is missing.

### Low-Medium: File Watcher Orphan Race And Duplicate Watchers

Evidence:

- `fs:watch-start` awaits `pathExists` after registering sender destroy cleanup.
- The code creates a watcher after that await without rechecking sender liveness.
- Watchers are keyed only by watch ID.

Impact:

- A renderer destroyed during `pathExists` can orphan a watcher.
- Duplicate path watchers can multiply descriptors/events across panels or windows.

Recommended action:

- Recheck `event.sender.isDestroyed()` immediately after `pathExists`.
- If watcher creation succeeds but sender has already died, close the watcher before returning.
- Consider dedupe/refcount by `(senderId, normalizedPath, recursive)`.

## Suggested Verification Plan

1. Reproduce current baseline with one terminal, then with 10, 25, and 50 terminals.
2. Close terminals and measure numeric FDs, `/dev/ptmx`, `/dev/ttys*`, and kqueues after 1s, 10s, and forced renderer/main GC if available.
3. Add a node-level lifecycle probe around `node-pty` so dependency changes can be checked without launching the full app.
4. Add unit tests for terminal teardown ordering and late output suppression.
5. Add tests for `fs:watch-start` sender destruction during `pathExists`.

Useful commands:

```bash
lsof -nP -p <main-pid>
ps -M -p <main-pid>
pgrep -P <main-pid> -fl .
ulimit -n
launchctl limit maxfiles
sysctl kern.maxfiles kern.maxfilesperproc
```

For `lsof`, count only rows whose FD column starts with a digit when estimating descriptor pressure.

## Current Priority

Fix terminal teardown observability and correctness first. Watcher dedupe/race cleanup is worthwhile, but the live evidence points to PTY resources as the main-process scaling problem.
