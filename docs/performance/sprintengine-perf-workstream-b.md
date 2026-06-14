# Workstream B — Terminal render & IPC fan-out (perf fix handoff)

> **Context for the agent picking this up:** Multicode has a severe UI performance
> regression during active SprintEngine runs (~37 terminals open, run
> "Pin Rebrand Redesign"). Symptoms: ~0.5s lag typing/pressing Enter in a
> terminal, laggy clicks, and **3–4s to switch workspaces**. A two-engineer
> parallel effort is underway. **Workstream A** (the SprintEngine engine/tick
> side) is owned by another engineer and is already in progress. **You own
> Workstream B: the terminal render + IPC fan-out side.** The two workstreams
> touch **disjoint files** — do not edit Workstream A's files (listed below).

## Diagnosis recap (why the app is slow)

The regression is compound. Workstream A is reducing per-tick CPU/IPC and stopping
an idle-retirement kill/respawn storm. **Your half** is the cost that each
SprintEngine state change (and each workspace switch) inflicts on the React
renderer and the terminal surface:

1. Every projection update mints **fresh agent object identities** in the store,
   which
2. churns the dependency array of TerminalView's xterm setup effect, which
3. **disposes and replays the entire xterm instance** (terminal teardown +
   `terminalSetVisible(false)` + reattach + replay + session broadcast), and
4. coarse store subscriptions fan a single agent change into a **grid-wide
   re-render**.

The 3–4s workspace switch is the same B1 path amplified: switching active
workspace remounts/re-runs the attach effect for every TerminalView in the
newly-active workspace at once.

## ⚠️ Guardrails (read before touching anything)

- **Do NOT touch Workstream A files:** `SprintEngineAutoRunSupervisor.tsx`,
  `src/renderer/src/utils/sprintengineAutoRun.ts`,
  `src/renderer/src/utils/sprintengineAutoRunExecutor.ts`,
  `src/renderer/src/utils/sprintengineProjectionRefresh.ts`,
  `SprintEngineProjectionSupervisor.tsx`, `src/main/sprintengine-artifacts.ts`.
- **Do NOT change SprintEngine dispatch *decisions*** (claim-first dispatch,
  per-agent dedup, which tasks/agents get spawned). This work is purely about
  rendering/identity stability and IPC overhead. B2 changes object *identity*
  reuse only — never which agents exist or their field *values*.
- **Performance > SprintEngine responsiveness.** It is fine for the UI to reflect
  SprintEngine state a beat later if that removes churn. Bias toward fewer
  re-renders / fewer xterm rebuilds.
- Preserve terminal **replay correctness** — a terminal must still show its
  scrollback after attach. Verify visually.

## Your files

`src/renderer/src/components/panels/TerminalView.tsx`,
`src/renderer/src/store/slices/runStateSlice.ts`,
`src/renderer/src/components/panels/AgentPanel.tsx`,
`src/renderer/src/components/workspace/WorkspaceManager.tsx`,
`src/main/terminal-runtime.ts`, `src/main/terminal-diagnostics.ts`,
`src/main/terminal-output-buffer.ts`.

---

## B1 — Stop TerminalView rebuilding the xterm on volatile deps (HIGHEST IMPACT)

**Problem.** The big xterm setup/teardown `useEffect` in `TerminalView.tsx`
(cleanup ends at `TerminalView.tsx:735`) has a dependency array (lines ~735-764)
that includes volatile / display-only values:

- `sprintEngineRuntimeAgent?.currentTaskId` (`:754`)
- `sprintEngineRuntimeAgent?.role` (`:755`)
- `sprintEngineRosterRole` (`:756`)
- `agent?.name` (`:742`)
- object identities `mcpSettings` (`:759`), `cliRuntimes` (`:749`)

When the projection updates (≈ every 2s tick on an active run) or work moves
between tasks, these change and the effect cleanup runs `term.dispose()`,
`terminalSetVisible(false)`, then a full reattach + replay + session broadcast.
That is a full terminal teardown per change, and on workspace switch it happens
for every terminal at once → the 3–4s stall.

**Fix.** Reduce the attach effect's deps to only what genuinely requires a
re-attach (terminal identity / lifecycle):
`sessionId`/`attachedSessionId`, `agent?.cliSessionId`, `agent?.cliRestartNonce`,
`workspaceId`, `agentId`, `agent?.kind`, `agent?.execution.mode`,
`agent?.execution.worktreeId`, `agent?.execution.cwd`, `folderReadyPath`,
`shouldKillOnUnmount`.

For the display/runtime values (`currentTaskId`, `role`, `rosterRole`, `name`)
and the settings objects:
- read them through a `useRef` updated in a separate lightweight effect, or
- split a second effect that applies metadata/prompt updates **without** tearing
  down xterm, or
- ensure `mcpSettings` / `cliRuntimes` are referentially stable (memoize at the
  provider/selector, or pull stable slices).

Be careful: some of those values feed the **startup prompt / onboarding** sent
when the PTY is first created. Make sure prompt construction still reads the
current value at spawn time (via ref) — just don't let a change to it *re-spawn*
an already-running terminal.

**Proof.** With diagnostics on, count `TerminalView` `terminal-detached-from-renderer`
(emitted at `TerminalView.tsx:702`) and reattach events during a live run:
should drop to ~0 except on real session changes (spawn/restart/kill). Manually:
typing into a terminal during a running sprint stays smooth; switching workspace
is fast.

## B2 — Make `reconcileSprintEngineAgents` identity-stable (root cause feeding B1 + re-renders)

**Problem.** `reconcileSprintEngineAgents` (`runStateSlice.ts:327-366`) is called
by `setSprintEngineState` on every projection change and **always rebuilds every
agent object with a fresh identity** (each entry goes through
`normalizeAgentState({ ...current, ... })` / `defaultAgent(...)` spreads) and
re-derives `name`. Fresh identities bust per-agent memoization everywhere
downstream (this is what keeps changing `agent?.name` for B1 and re-rendering
`AgentPanel`/`TerminalView`).

**Fix.** Make it return the **same object reference when nothing changed**:
compute the next agent, then if it is field-equal to `currentAgents[id]`, reuse
the existing reference instead of the new object. Only allocate a new agent
object when a field actually changed. Only re-derive `name` when the current
name actually needs to change (the `isDefaultSprintEngineAgentName` branch
already gates this — make sure the stable path returns `current` untouched).
Also return the **same top-level agents map reference** when no agent changed,
so `setSprintEngineState` doesn't bump the workspace object identity on no-op
projections.

**Watch:** `setSprintEngineState` (`runStateSlice.ts:503-522`) assigns
`ws.agents = reconcileSprintEngineAgents(...)` unconditionally. If you return a
stable reference, immer still won't bump identity (assigning the same ref is a
no-op for structural sharing) — good. Verify the merge order
(`specialistAgents`, `transientSprintEngineAgents`, `rosterAgents`) is preserved.

**Proof.** Add a unit test in `runStateSlice` (or the nearest store test) that
calls `reconcileSprintEngineAgents` twice with an unchanged state and asserts
`Object.is` on the returned map and each agent. Downstream: fewer
TerminalView/AgentPanel re-renders in the React profiler.

## B3 — Narrow coarse store subscriptions

**Problem.**
- `WorkspaceManager.tsx:137` — `useWorkspaceStore((s) => s.workspaces)` subscribes
  to the **whole workspaces array**, whose identity changes on every store write
  (immer). It feeds many `workspaces`-keyed `useMemo`s, so any write re-renders
  the grid host.
- `AgentPanel.tsx:67` — `s.workspaces.find((w) => w.id === workspaceId)` returns
  the **whole workspace object**, which immer replaces whenever any agent in it
  changes → re-renders every panel in that workspace.
- `TerminalView` derives `workspaceName` / `sprintEngineContext` /
  `sprintEngineRosterRole` / `startupPrompt` from whole-object selectors
  (`:148-205`).

**Fix.** Replace whole-array / whole-object selectors with field-scoped
selectors, or use `useShallow` (zustand) / explicit equality so a component only
re-renders when the specific fields it reads change. For `WorkspaceManager`,
prefer selecting the narrow slices it actually needs (ids, active id, the
specific workspace) rather than the whole array; move `workspaces`-keyed memos to
narrower inputs.

**Proof.** React DevTools Profiler: mutating a single agent re-renders only that
agent's pane, not the whole grid.

## B4 — Trim background overhead (quick wins)

**B4a — `recordDataBatch` lacks the `!enabled` guard.** In
`terminal-diagnostics.ts:31`, `recordDataBatch` accumulates stats and calls
`logMainPerfEvent` even when diagnostics are disabled — unlike `recordInputWrite`
(`:77`) and `recordActivityTransition` (`:124`), which both early-return on
`!enabled`. Add the same `!enabled` guard (or gate the `logMainPerfEvent` call).

**B4b — dev console logging is always on.** `logMainPerfEvent`
(`main-diagnostics.ts:11`) only short-circuits when `app.isPackaged && !enabled`,
so in a dev build it `console.info`s on every call regardless of the diagnostics
toggle. Combined with B4a, that's per-second console spam per terminal (×37). Make
"diagnostics off" actually quiet in dev (respect `enabled` even when not packaged,
or remove the per-batch log from the hot path).

**B4c (optional, lower priority — needs care).** Every PTY byte fans out over
`terminal:data:${id}` IPC for **all** sessions regardless of visibility
(`terminal-runtime.ts:861`, no visibility gate). Output is already batched (16ms)
and capped (256KB) in `terminal-output-buffer.ts`, so this is secondary. If you
touch it, only **throttle/defer** sends for non-visible sessions — never drop
history (server-side buffering must remain intact so replay on re-attach is
correct). Verify replay after switching to a previously-hidden terminal.

**Proof.** Main-process console is quiet when diagnostics are off; renderer
`terminal:data` event rate for hidden terminals drops (if B4c done).

---

## Suggested order & proof gates

Land **one change at a time, prove it, then move on** (the project is running
proof-gated):

1. **B1** (biggest single win; fixes the workspace-switch stall). Prove reattach
   events ~0 + smooth typing/switching.
2. **B2** (removes the churn that makes B1 fire; also cuts re-renders). Prove with
   the identity-stability unit test.
3. **B3** (caps re-render fan-out). Prove with the React profiler.
4. **B4a/B4b** (cheap, safe overhead trims). B4c only if time permits and replay
   is verified.

## How to measure

- Enable diagnostics so `logPerfEvent` (renderer) and `logMainPerfEvent` (main)
  emit to the consoles.
- Renderer DevTools → Performance: record ~6s during an active run and on a
  workspace switch; look for long tasks / React commits on the terminal grid
  before vs after.
- React DevTools → Profiler: confirm a single agent change no longer re-renders
  the whole grid.
- Run the suite after each change: `npm test` (and the terminal-runtime /
  store tests specifically). The existing tests encode the contracts — keep them
  green.

## Coordination

- Workstream A is removing redundant per-tick IPC and the retirement storm, which
  reduces how *often* your hot paths fire. Your fixes reduce how *expensive* each
  fire is. They compose; no shared files.
- If you believe a fix needs to touch a Workstream A file, stop and coordinate —
  that's the seam we're keeping clean to avoid merge conflicts.
