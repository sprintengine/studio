# Validation report — First run without a wizard

Epic: `backlog/epics/first-run-without-a-wizard.md` (MC-2043)
Validated: 2026-07-31, at `b5db6f16`, against the **built** app
(`out/main/index.js`), not the dev server.

Every run used an isolated `MULTICODE_USER_DATA_DIR` with
`MULTICODE_ALLOW_MULTI_INSTANCE=1`, so none of it touched the operator's own
profile or running instance.

---

## Epic acceptance

| Epic acceptance | Result |
|---|---|
| A fresh install reaches a usable workspace without answering a single question, on a machine with an agent CLI | **PASS** |
| A fresh install with **no** agent CLI is asked exactly once, in one card, and never again after dismissal | **PASS** |
| An existing profile upgrading sees no card, no wizard, and no change to theme, modules or adopted MCP servers | **PASS** |
| No blank window at any point in launch | **PASS** |
| Creating a standard workspace never shows a layout page | **PASS** |

---

## 1. Fresh profile, agent CLI present

Window timeline, from process start:

```
  419ms  splash:visible   main:hidden
  627ms  splash:gone      main:visible
```

- **Never both visible, never neither** — asserted across the whole transition,
  not sampled at the ends.
- Over the following 3000 ms, sampled every 100 ms: no welcome step, no theme
  step, no modules step, no payoff screen, and **no CLI-card flash** while the
  probe was still resolving. The card's `'ready'` gate is what buys this.
- Landed state: file explorer, editor and one agent terminal — the Solo Dev
  layout — reached with zero questions.

Evidence: `t4-splash.png`, `t4-landed.png`.

## 2. Fresh profile, no agent CLI

**Technique note.** Stripping `PATH` does *not* simulate this machine.
`detectCli` spawns a **login shell**, which re-sources the user's profile and
puts `~/.local/bin` back — a "no CLI" run still found claude, opencode, cursor
and kimi. Overriding `HOME` hung the app. What works: read every registered CLI
from `pluginsList()` and point each at a nonexistent command in persisted
`cliRuntimes`, so the real probe legitimately reports `installed: false`.

```
CLIs present      → card = false
9 CLIs overridden → card = true      (only after the probe resolved)
"Not now"         → card = false, persisted firstRunCliCardDismissed = true
relaunch          → card = false
```

Evidence: `no-cli-card.png`.

## 3. Existing profile — a real upgrade, not a synthetic one

The **pre-sprint build** (`9e126fdc`) was built into a separate worktree and
launched first, then walked through the real onboarding wizard: a non-default
theme picked, one module switched off, the essentials step skipped. That is
genuine on-disk state, not a hand-written fixture. The new build was then
launched against the same profile directory.

| | before (old build) | after (new build) | |
|---|---|---|---|
| `appearance.theme` | `gruvbox` | `gruvbox` | unchanged |
| `modules` | `{"memory-graph": false}` | `{"memory-graph": false}` | unchanged |
| `modulesChosen` | `true` | `true` | still readable |
| `onboardingStep` | `"workspace"` | *(consumed)* | converted, never rewritten |
| `firstRunCliCardDismissed` | — | `true` | derived from the legacy signals |

Over a 6-second settle window: no welcome, no theme step, no modules step, no
payoff, **no card**.

Note this profile had **zero workspaces**, which makes it the stronger test: the
dismissal was derived from the retired `onboardingStep` / `modulesChosen` keys
rather than from the has-workspaces shortcut.

Evidence: `upgrade-before.json`, `upgrade-after.json`, `upgrade-1-old-build.png`,
`upgrade-2-new-build.png`.

## 4. Standard workspace creation

- No `Pick an IDE layout` page anywhere in the hub.
- Zero progress stations in the header (a one-page flow renders no strip).
- Footer carries only `Create workspace` — no `Continue`, so it is genuinely one
  page.
- The created workspace has the Solo Dev shape: explorer + editor + one agent
  terminal.

## 5. Renderer crash mid-boot

```
  413ms  launched: splash visible, main hidden
  423ms  renderer force-crashed (before app:boot-complete)
  684ms  main window REVEALED, splash destroyed, no orphan
```

Revealed 261 ms after the crash via `render-process-gone` — it does not wait out
the 10 s timeout, and the always-on-top plate never outlives the window it was
covering.

## 6. The splash loads no app bundle

Checked against the **built** `out/renderer/splash.html`:

- `<script type="module">` — **0**
- `<link rel="stylesheet">` — **0**
- only asset reference: `./assets/backdrop-herbarium-dark-chat-7pu48ZtY.jpg`

The item's suggested check ("stop the dev server") is not achievable for a dev
build whose HTML that same server serves; this is the property it was reaching
for. The plate reuses the app's existing backdrop asset — no duplicate was
emitted.

---

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck:all` | 39 errors — **identical set reproduced at `9e126fdc`**, all in unrelated test files |
| Full `verify:app` suite (387 scripts) | **383 pass, 4 fail** |
| `scripts/check-bundle-budget.mjs` | **PASS** — 2026 KB, under the 2048 KB ceiling |

The four failures are `test:sdk:drift`, `test:renderer:xterm-output-queue`,
`test:renderer:sprintengine-handoff` and `test:seams:premium-feel`. **All four
were re-run at the pre-sprint commit and fail there too** — pre-existing, none
attributable to this epic.

The bundle budget is the one gate this epic *improved*: it was failing at HEAD
(2072 KB, over the ceiling) and deleting the wizard took the eager chunk to
2026 KB.

---

## Open items for the owner

1. **Brand rule conflict.** `knowledge/brand/BRAND-MARK.md` rules the wordmark
   has exactly one in-app placement (the sidebar brand row) and that "a second
   placement retires the first rather than joining it". The splash's centred
   wordmark is a second placement. It was built per the owner's explicit
   variant-A ruling on this surface, and the sidebar row was deliberately left
   alone — retiring it is a product decision. Either the brand note gains a
   launch-window carve-out, or the sidebar row goes.
2. **Two acceptance criteria in MC-2044 contradict each other.** "The hairline
   reaches full before the main window appears" cannot hold alongside "the splash
   closes on `app:boot-complete` or a 10 s timeout, whichever comes first":
   hydration finishes at ~630 ms while the CLI probe is still running, so the
   reveal lands with the hairline short of full. Gating the reveal on discovery
   would hold the user out of the app for a probe the first frame does not need.
   The reveal contract was kept; this criterion is met in spirit, not literally.
3. **Adoption read-out is session-scoped.** The one line in Settings → Agents is
   transient state, so a user who never opens that tab in the session where
   adoption ran will not see a failure reported. Matches the item as written;
   worth revisiting if adoption failures turn out to matter.
4. **User layout templates lost their only UI.** The deleted `StandardLayoutStep`
   held the only control for installing a user layout template folder, and the
   only way to select one — the Command Palette lists bundled templates only. The
   IPC and `listUserLayoutTemplates` plumbing were left intact so a Settings
   surface plugs straight in, but building one needs a mockup per the standing
   owner rule.
