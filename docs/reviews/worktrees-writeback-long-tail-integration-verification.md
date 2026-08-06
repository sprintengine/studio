# Integration verification — Worktrees, Writeback, and the Long Tail (T9)

Terminal verification for the run that closed MC-2123, MC-2136, MC-2137,
MC-2140, MC-2134, MC-2138, MC-2139 and MC-2135. Written 2026-08-06.

This report separates what was **exercised for real** from what was **not
exercised**. A step verified only by reading source is recorded as unverified,
per the task's own acceptance.

## Harness

The app was driven as the app, not as a test harness: `npm run build`, then the
built `out/main/index.js` launched under Playwright's Electron driver with an
isolated profile (`MULTICODE_USER_DATA_DIR`, `MULTICODE_ALLOW_MULTI_INSTANCE=1`)
against a throwaway git project under `/tmp` holding two epics — one carrying
`dependenciesPlanned: true`, one not — and three child items.

**One trap worth recording for the next agent.** A Sprint Engine agent terminal
inherits `ELECTRON_RENDERER_URL` from the Multicode instance that launched it.
Left in the launch environment, Playwright's Electron loads the renderer from
the developer's Vite server — which serves the **main checkout**, not the branch
under test. The first four passes of this verification reported on main's
renderer and showed the MC-2123 "Runs in" row as missing, because on main it
genuinely is. Any harness that drives the built app from inside a sprint
terminal must `delete env.ELECTRON_RENDERER_URL`, and should assert that every
loaded script is `./assets/...` before trusting a single observation.

## Verified for real

- **The renderer under observation was the branch's build**, asserted in-harness
  (all `<script src>` are `./assets/…`, no dev-server URL). Every observation
  below is gated on that check.
- **MC-2123 — worktree mode is reachable from the New sprint dialog.** With an
  epic picked, the roleless team card renders the "Runs in" row as a real
  combobox: `[role="combobox"][aria-label="Runs in"]`, value **"One worktree"**.
  The default is the per-sprint worktree, matching the 2026-08-05 owner ruling.
  Observed in the running app, not inferred.
- **MC-2137 — the epic ordering gate flips the Planning agent default.** Picking
  the epic that carries `dependenciesPlanned: true` moved the row from
  `Planning agent: Claude Code` to `Planning agent: None`, and the footer to
  "2 tasks from your epic". Observed in the running app.
- **MC-2139 — the new suite is in the `verify:app` chain, by name.**
  `test:renderer:sprint-create-automation` resolves to
  `src/renderer/src/hooks/useAutomationRequests.test.tsx` and appears in the
  `&&` chain, so it actually runs. The acceptance criterion the plan added for
  exactly this failure mode holds.

## Fixed while verifying

`verify:app` aborted three times on stale expectations that predate this sprint.
All three were confirmed against the branch point (`977c59b73`) and are fixed
here, test-side only — in each case the product string is the intended one and
the expectation had been left behind:

| Suite | Cause |
| --- | --- |
| `test:renderer:terminal-link-menu` | Escape dispatched on `window`; `ContextMenu` moved its listener to `document` in `819fddb38`. Fixed on main in `c4685ad84`; the same fix is applied here. |
| `test:renderer:xterm-output-queue` | Throttle banner shortened in `5912ed928` (2026-07-29); expectation left on the old wording. Still red on main. |
| `test:renderer:sprintengine-handoff` | "The Multicode app owns runner policy" shortened to "The app owns runner policy" in the same commit, in two assertions. Still red on main. |

## Not verified — and what blocked each

The sprint was ended by the operator before these ran. Each is stated as
unverified rather than inferred from the diffs.

- **MC-2123/MC-2136 — the created run's `vcs` block.** The dialog control was
  observed; no sprint was actually started, so `vcs.mode: run_worktree`, its
  `worktreePath`, and `vcs.taskIsolation` on a per-task run were **not** read off
  a real run store.
- **MC-2136 — the terminal-cwd seam.** Not exercised. This is the seam the plan
  called the one most likely to be half-done, precisely because the engine half
  already existed and only the routing is new. The harness to observe it was
  built (spawn the run, then read each descendant process's real cwd via `lsof`)
  but never run. **This remains the highest-value unverified step in the sprint.**
- **MC-2140 — backlog write-back on a task reaching `done`.** Not exercised. No
  item was observed moving to `completed` with a server-stamped `updated:`, and
  the "no epic file written / no manual propagation commit" halves were not
  checked.
- **MC-2134/MC-2138 — the dialog surfaces after the sweeps.** The dialog opened,
  rendered its backlog list, its team card and its two rows, and took a pick
  without a render error, which is weak evidence that the combobox and menu
  convergence did not break this flow. The keyboard behaviour the ruling is
  actually about was not driven.
- **`verify:app` end to end.** It does **not** pass. After the three fixes above,
  five suites still fail: `test:renderer:global-doors-integration`,
  `test:seams:roster-effort`, `test:seams:model-catalog-effort`,
  `test:seams:skill-sources`, `test:seams:premium-feel`. Each was re-run at the
  branch point and fails there with a **byte-identical** assertion message, so
  none is this sprint's regression — the tree was already red on them when the
  sprint branched, and they are red on current `main` too. They are not fixed
  here because five unrelated surfaces are well outside this task.

## Bottom line

The two design-level claims that could be checked in the real app — worktree
mode is reachable, and the ordering gate flips the planning default — both hold.
The engine-side claims underneath them (what the run store records, where the
agent terminals land, and whether a finished task writes its item back) are
**unverified**, and the sprint should not be read as having proven them.
