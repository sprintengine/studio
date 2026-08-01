# Module platform — real-app drive validation (T12)

Sprint `module-extraction-marketplace`, task T12. The sprint's cross-cutting
acceptance requires the landed module platform (T5–T10) proven in the **real
built app**, headlessly driven — not through unit suites. All five checkpoints
from the task card were driven end to end; **28/28 checks passed** on the final
run. No product code was changed by this task.

## How to reproduce

```
npm run build
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund
NODE_PATH="$tmp/node_modules" node scripts/testing/module-platform-drive.mjs
```

Screenshots and `report.json` (full check list + recorded env) land in
`/tmp/multicode-t12-module-platform/out`; the run captured for this report is
committed under `docs/testing/t12-module-platform-drive/`.

**Recorded env** (also in `report.json`): `ELECTRON_RENDERER_URL` is set to the
empty string explicitly — this terminal inherits `http://localhost:5173` from
the dev session, exactly the trap the epic warns about, so the harness
overwrites rather than inherits. Isolation is `MULTICODE_USER_DATA_DIR` +
`MULTICODE_USER_MODULE_ROOT` under `/tmp`; the user's real profile, module
root, and `~/.multicode` are never touched (no `HOME` override — see trap 1).

## The fixture, because the real registry can't serve one yet

The drive installs two raw third-party modules into the isolated module root
and trusts them through the real Settings → Modules switches:

- **`pw-deck`** registers workspace type `pw-deck` (creation step "Which
  city?", `blockedHint`, template that names a tab `Forecast: <city>` and
  embeds a `pw-widgets.gauge` tab), a throwing-step type `pw-crash`, a global
  supervisor that calls `watchAgentSessions`, and
  `deriveRunGlyph → "2 scheduled today"`.
- **`pw-widgets`** registers only the `pw-widgets.gauge` panel.

The bundled marketplace index has **zero `provides:["module"]` entries** (see
finding F1), so the module-surfacing checkpoints are driven through the
documented `MULTICODE_MARKETPLACE_REGISTRY_URL` override: the harness serves a
fixture index (`pw-deck`, `pw-widgets` as modules, `pw-skill-pack` as a skills
contrast) from a local self-signed HTTPS server, `NODE_TLS_REJECT_UNAUTHORIZED=0`
scoped to the launched validation app only. The final run read it live:
`{"ok":true,"state":"ok","source":"network","stale":false}`.

## Checkpoints

| # | Behavior | Result | Evidence |
|---|---|---|---|
| 1a | Workspace whose mode's module is not installed → explicit surface, module name, working install affordance | **Pass** | `d-cp1a-absence-surface.png` — "Pw-deck isn’t installed", data-safe copy, `Find it in Connectors` routes to the extensions browse surface (`d-cp1a-routed-to-browse.png`); no blank pane, no crash, and both restored module-mode workspaces render their own notes |
| 1b | Layout tab whose owning module is missing → upgraded surface | **Pass** | `c-cp1b-missing-tab-surface.png` — with only `pw-widgets` removed, Deck One renders normally and the Gauge tab shows "Playwright Widgets isn’t installed" (name resolved from the registry `module` entry) with the install affordance |
| 2 | Uninstall/distrust guard lists open dependent workspaces | **Pass** | `b-cp2-distrust-guard.png` — toggling Trust off on Playwright Deck raises "Stop trusting this module?" naming **Deck One**; Cancel keeps trust intact. Note: distrust is the only destructive path — no module uninstall affordance exists (F3) |
| 3 | Modules category in the browse surface, module-led cards, no launch affordance on module-only plugins | **Pass** | `d-cp3-modules-canvas.png` — Extensions door → "Modules · 2 available" → "Capability modules" heading; card name/summary are the manifest's `displayName`/`summary` verbatim, kind chip "Module", `Get` present, no "New chat" on the card (the sidebar's global New chat is outside the canvas and excluded from the assertion) |
| 4 | Creation step pane; value reaches the workspace; throwing step degrades | **Pass** | `b-cp4-step-pane-blocked.png` — "Which city?" pane with Create disabled and the `blockedHint` in the footer; after "Dublin", the created workspace's tab is **Forecast: Dublin** (`b-cp4-created-workspace.png`). `c-cp4-throwing-step-degrade.png` — `pw-crash`'s step throws and renders the exact degrade copy; create proceeds zero-config (`c-cp4-zero-config-created.png`) |
| 5 | Third-party supervisor mounts and observes session state; run glyph renders | **Pass** | `b-cp5-supervisor-glyph.png` — supervisor mounted at boot (`__pwDeckSupervisorMounted`), received real snapshots through `watchAgentSessions` for the created workspace (observation log in `report.json` check detail), and the sidebar row carries the `role="img"` glyph labeled "2 scheduled today · last typed …" |

## Traps this harness documents (they cost most of the session)

1. **Never override `HOME`.** Pointing `HOME` at an empty dir wedges the built
   app under Playwright on this macOS setup: every CDP round-trip
   (`evaluate`, `reload`, `keyboard.press`, `screenshot`) times out forever
   while the app looks healthy. Verified differentially: 6/6 evaluates ok
   without the override, 0/6 with, same launch otherwise. This is very likely
   the origin of the "keyboard.press intermittently wedges" folklore in
   `third-party-renderer-modules-e2e.mjs` — which still overrides `HOME` and
   currently hangs at HEAD (finding F2).
2. **Never `app.evaluate`.** The Electron-main inspector session Playwright
   uses for it drops ("Debugger ending on ws://…"), and the call hangs with no
   timeout. Settings opens through its real top-bar button (`aria-label`
   "Settings"); `Primary+,` is not reachable synthetically.
3. **The boot replaces its first window** (window restore): treat a closed
   first window as "adopt the surviving window", not as a crash. The app also
   very occasionally quits cleanly (exit 0) seconds after boot when relaunched
   quickly on the same profile; the harness retries up to 3×.
4. **The tip-of-the-day modal** opens over the shell on boots with restorable
   state (a fresh profile that was never seeded with
   `learning.showTipsOnStartup: false`) and intercepts every click; the
   harness dismisses any `.overlay-scrim` before driving.
5. **Onboarding seeding is obsolete.** A fresh profile boots straight into the
   workspace hub at HEAD; seeding the old version-59 settings envelope makes
   the app quit moments after boot. The drive runs on genuine fresh-profile
   state.

## Findings

- **F1 (known, tracked)**: the bundled marketplace index carries no
  `provides:["module"]` entries, so in the shipping app the Modules shelf is
  empty and the 1b tab upgrade can never resolve a module name. This is
  MC-2074 (registry seeding blocked on upstream npm credentials), split out of
  MC-1531 — not re-filed here. Verification once seeded: re-run this drive
  without the registry override and assert the real calendar entry renders.
- **F2 (test infra)**: `scripts/testing/third-party-renderer-modules-e2e.mjs`
  hangs at HEAD (watchdog expiry, Electron left holding the scratch profile)
  because of the `HOME`-override wedge in trap 1. Fix is mechanical: drop the
  `HOME` override, isolate via `MULTICODE_USER_MODULE_ROOT`, open Settings via
  its top-bar button. Owner: tester/developer.
- **F3 (observation, product decision pending)**: there is no module
  *uninstall* affordance — distrust is the only destructive path, so the
  T8 guard is only reachable through the trust switch. Consistent with the
  current design (bytes stay on disk); noting it so the epic's "uninstall
  guard" wording isn't read as a shipped uninstall flow.
