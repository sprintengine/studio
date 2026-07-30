# Context rail — one navigation column, every door, every state (T19)

Item 1993's first acceptance criterion is absolute: **"No app state shows two
navigation columns left of content, anywhere."** T7 landed the substrate; T12's
adversarial review (finding T12-F1) found the two doors-side states where the
product still broke it. T19 closed both:

- **Backlog** passed no rail, so the projects sidebar stayed mounted and the door
  painted its work list beside it — two selectable columns before the preview.
  The work list is now the door's rail and the item detail takes the whole canvas.
- **Rail presence was derived from content.** Sprints (`runs.length > 0`),
  Automations (`entries.length > 0 || editorTarget`), Horizon (`hasRoadmaps ||
  error`) and Reviews (`index.phase !== 'loading'`) gated the prop on having data,
  so an empty or still-loading door kept the projects rail. Every door now
  declares its rail in every load state.

> The task card stated Reviews already passed its rail unconditionally. It did
> not — it withheld the rail on the pristine first load. Acceptance criteria 4 and
> 8 cover all six doors and the loading state, so Reviews was fixed too.

## How this was measured

Two layers, because they prove different things.

**The declaration** — `globalDoorsIntegration.test.tsx` §8 mounts all six real
surfaces inside a recording `ContextRailSlotContext.Provider` and asserts each
reports `onRailPresence(true)` both on first paint (nothing resolved) and after
settling with nothing in it. That is the exact signal the host derives
`contextRailActive` from. Confirmed to fail when a door reverts: restoring
Sprints' `runs.length > 0` gate produces *"the sprints door declares its rail on
first paint — a loading door must not leave the projects rail up"*.

**The consequence** — `scripts/testing/context-rail-door-pass.mjs`, in the real
Electron app. A unit test cannot show that the projects rail is actually off
screen. This reads it as geometry (`offsetParent`, bounding box) rather than as a
class name, because the projects rail stays deliberately **mounted** while a door
owns the column — the door's trigger row has to survive for Back to focus it.

```
tmp=/tmp/multicode-playwright
npm --prefix "$tmp" install playwright --no-audit --no-fund
npm run build
NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
  node scripts/testing/context-rail-door-pass.mjs
```

Result: **101/101 checks passed.** Screenshots and a JSON transcript land in
`$MULTICODE_T19_OUT_DIR` (default `/tmp/multicode-t19-context-rail/out`).

Two traps the harness documents and handles:

- The **built** renderer hides Horizon and Reviews — both are on
  `DEV_ONLY_MODULE_IDS`, gated by `import.meta.env.DEV`. Measuring "all six doors"
  off `out/renderer` silently measures four. The harness serves *this worktree's*
  renderer from its own vite dev server and overwrites `ELECTRON_RENDERER_URL`
  rather than inheriting an ambient one pointing at another tree.
- The onboarding **"What's included" modal focus-traps.** Left open it owns every
  Escape, and five doors reported no keyboard exit — a harness artefact, not a
  product defect (`escapeLeavesSurface` correctly yields to an overlay). The
  dismissal is now part of `finishOnboarding`.

## Per door, per state — 1993 AC1 re-checked

`navColumns` is every navigation column laid out left of the canvas: the projects
tree, the door's rail column, and any inline aside a surface drew for itself.
One entry, and that entry `context-rail`, is the rule holding. `barChevrons`
counts back affordances **inside the surface region** — zero is the rule ("the
canvas carries no back affordance"); the sidebar chrome's own nav-history arrow is
also labelled "Back" but lives in the fixed brand row that does not participate in
the swap, and counting it document-wide reported a false chevron on every screen.

### With a project open

| Door | still loading | resolved | rail rows | canvas back affordances |
|---|---|---|---|---|
| Automations | `context-rail` | `context-rail` | 0 (empty) | 0 |
| Sprints | `context-rail` | `context-rail` | 0 (empty) | 0 |
| Backlog | `context-rail` | `context-rail` | 5 | 0 |
| Extensions | `context-rail` | `context-rail` | 7 | 0 |
| Horizon | `context-rail` | `context-rail` | 0 (empty) | 0 |
| Reviews | `context-rail` | `context-rail` | 0 (empty) | 0 |

In every row above the projects tree measured `laidOut: false, mounted: true` —
off screen and untabbable, but still there for Back to hand focus to.

### Backlog, the two states the task names

| State | navColumns | canvas |
|---|---|---|
| Populated, item selected | `context-rail` (5 rows) | the item detail, full width — `backlog-populated.png`, `backlog-populated-dark.png` |
| Empty (search matches nothing) | `context-rail` (0 rows) | "Nothing matches this view" — `backlog-empty.png`, and the rail keeps New item plus the search that emptied it |

The empty canvas carries no "New item" CTA: this is a *filtered*-empty state, not
a first run, and the rail's New row sits beside it with the lens that emptied the
list right under it. (Backlog's genuine first-run state, "No projects open", has
no CTA either — there is no project to create into, so the rail's New row renders
inert rather than opening an empty project picker.)

### No project open — a first-run profile

The state 1993's "anywhere" makes worst: no rows to escape through, so a door
that kept the projects rail kept a rail with nothing in it.

| Door | navColumns | rail rows | canvas |
|---|---|---|---|
| Automations | `context-rail` | 0 | "No automations yet" |
| Sprints | `context-rail` | 0 | "Run your first sprint" |
| Backlog | `context-rail` | 0 | "No projects open" |
| Extensions | `context-rail` | 7 | catalog |
| Horizon | `context-rail` | 0 | "No horizon yet — Open a project to plan a horizon." |
| Reviews | `context-rail` | 0 | "No reviews yet" |

Escape leaves all six, with focus measured inside the rail column each time.

## The rail row's own affordances

The work list changed HOSTS — its rows are portaled into the sidebar's column now
rather than living in the door's canvas — so the things that hang off a row were
re-checked live rather than assumed:

| Checked | Result |
|---|---|
| Right-click a rail row | opens the row menu (19 controls) |
| Escape with that menu open | closes the **menu**, leaves the door open and the rail up |
| Rail keyboard walk | the list is still the door's `role="listbox"` with `aria-activedescendant`; `data-selection-pane="primary"` stays on the `<ul>` that holds the `aria-selected` row, so the token rebinding still lands |

The second row is the one that matters: an overlay on a door owns Escape first
(`escapeLeavesSurface` yields to `dialog`/`alertdialog`/`menu`/`listbox`), and the
rail moving into the sidebar's column must not change that.

## One focused selection — a defect this pass found (AC 2)

The review of the diff turned up a real one, and it needed a measurement to see.

The rail's work list declares itself the door's `data-selection-pane="primary"`,
which means it holds the full-strength `--bg-selected` while focus sits outside
every pane and rests only when another **pane** takes focus. Moving the list into
the sidebar's column put it INSIDE `<aside aria-label="Workspaces">`, which is
itself `data-selection-pane="auto"` — and `auto`'s rule ("rest on anything not
`:focus-within`") has no nesting guard, so it governed the nested pane instead of
its own. Measured: the selected rail row dropped `--bg-selected` → 
`--bg-selected-resting` the moment focus moved to the door's detail pane, leaving
the screen with **zero** focused selections instead of one.

Fix: while a door owns the column the aside is not the pane, so it drops
`data-selection-pane` entirely (`WorkspaceSidebar.tsx`). Nothing there loses its
own tier — the workspaces tree is `hidden` in that state, so its rows are neither
visible nor focusable. This also repairs every other door's rail, which has been
nested inside the same `auto` aside since T7.

| Focus | Selected rail row fill | |
|---|---|---|
| In the rail | `rgb(36, 36, 44)` = `--bg-selected` | one focused selection |
| Outside every pane (the door's region) | `rgb(36, 36, 44)` — was `rgb(28, 32, 36)` = resting | holds, as `primary` promises |

## Back and Escape (AC 5)

Exercised from Backlog (populated) and from Automations (empty), by both routes:

| Door | Route | Projects rail back | Door's rail gone | Tree scrollTop | Focus lands on |
|---|---|---|---|---|---|
| Backlog | rail Back row | yes | yes | 24 → 24 | `Backlog` trigger |
| Backlog | Escape | yes | yes | 24 → 24 | `Backlog` trigger |
| Automations | rail Back row | yes | yes | 24 → 24 | `Automations` trigger |
| Automations | Escape | yes | yes | 24 → 24 | `Automations` trigger |

The scroll offset is a **real** measurement, not a degenerate one, and the way it
got there is stated because it is a staged precondition: this fixture's single
project cannot fill even a 300px-tall window, so the first run reported 0 → 0 and
proved nothing. An inline `max-height` on the tree's own scrollport forces the
overflow (`scrollHeight` 72 vs `clientHeight` 48); everything after that is the
product's path — hiding the nav drops its offset to zero, and the effect keyed on
the rail's activation restores `treeScrollTopRef` before the returned rail paints.
Creating extra workspaces to overflow it naturally was tried first and abandoned:
the "New Workspace" button is the empty-state CTA and is gone once a workspace
exists.

A note on the first run of this pass: focus initially landed on a terminal input,
not the trigger. Cause was the harness — a programmatic `.click()` does not focus
its target, so `useSurfaceTriggerFocus` captured whatever *was* focused and Back
honestly returned there. Opening a door now focuses the row first, as a pointer
click does.

## Dark

`--rail-ground` is the material the rail's sticky head paints to cover rows
passing under it, and in this column it must be the **sidebar's** ground, not the
door-panel raised tone — otherwise the rail reads as a panel dropped into the
chrome. Measured in dark: `--rail-ground: #08080c`, head background
`rgb(8, 8, 12)`, column background `rgb(8, 8, 12)`.

## A stale harness, not a regression

`scripts/testing/design-system-integration-pass.mjs` (T24's one-time selection-tier
and focus-ring measurement) now reports failures against this change. They are not
product regressions — it encodes the shape T19 removed:

- It navigates door → door by clicking **sidebar rows while a door is open**, which
  worked only because Backlog used to leave the app sidebar mounted. Those rows are
  `display:none` now, so its Extensions leg silently re-measures the Backlog door
  and every "no ring" result is a hidden control.
- Its `resting-selected` read moves focus into "another selection pane". A door
  surface now has exactly **one reachable** selection pane — its rail — which is
  the point of one rail, ever. Measured here: with the Backlog door open the pane
  inventory is `[primary "Backlog items across projects", auto <div>]` and only the
  first takes focus; the workspace card's pane is still mounted and still has a box,
  but the door paints over it. So that tier has no witness on a door and the read
  falls back to the selected fill.

The harness carries a header note saying so. It is a manual pass, not wired into
`npm run verify:app` or any `test:` script. What it used to prove about the tiers on
this door is covered above and by `test:seams:design-system-conformance` (which
passes).

## Pre-existing failures, reproduced at HEAD

Neither is caused by this change; both were reproduced with the change removed.

| Gate | At the pre-T19 commit | With T19 |
|---|---|---|
| `npm run build` bundle budget | FAIL — eager chunk 2075 KB over a 2048 KB ceiling | FAIL — 2076 KB (rounding-level; every edit is inside lazily-loaded door chunks or in comments) |
| `npm run lint:knowledge-size` | crashes `EISDIR` reading a `knowledge/` subdirectory as a file | same crash with the KG edits stashed. Not in the `npm run lint` chain |

`npm run typecheck` and all six `npm run lint` guards are clean.
