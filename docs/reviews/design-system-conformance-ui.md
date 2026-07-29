# Visual conformance review — design-system conformance sprint

Task T13. Under review: the shipped surfaces of T3–T12, judged against the
build-to-it mockups under `backlog/mockups/2026-07-28-*.html` and
`design-system/foundations/principles.md`.

Verdict: **changes requested.** Nine findings. The mechanical rules landed —
the guard is honest about what it measures, and every rule it owns reads clean
in the running app. What it cannot see is whether the result *works*, and on
the epic's own reference surface it does not: on any Backlog row that belongs
to an epic, **you cannot tell which row you selected**. The neutral fill T4
shipped is overpainted by a colour code the sweep never counted, and the left
bar T4 retired is still drawn under it.

Two of the three highest-judgement outcomes have a real defect (T4 selection,
T3 contrast floor). The third (T11, the tab primitive) is correct.

## Method

Everything below was measured in the **real Electron app**, built from this
branch (`npm run build`, `out/main/index.js`) and driven through Playwright
`_electron` on an isolated profile (`MULTICODE_USER_DATA_DIR=/tmp/mc-review-user-data`,
`MULTICODE_ALLOW_MULTI_INSTANCE=1`). The workspace under test is a throwaway
copy of this repo's `backlog/` (211 live items across 1 project) opened through
the `MULTICODE_TEST_OPEN_DIR` seam. Viewports: **1440×900** primary, plus
**1024×768**, **768×1024** and **390×844** for the responsive pass.

Colour claims are computed values read back through `getComputedStyle`, with
`oklab()` and `color-mix()` fills resolved to sRGB through a 1×1 canvas so a
tinted row can be compared with a token on the same scale. Contrast is WCAG
2.1 relative luminance.

**Harness trap, recorded because it would have invalidated the whole review.**
This shell inherits `ELECTRON_RENDERER_URL` and `NODE_ENV_ELECTRON_VITE` from
the operator's running dev server. Passed through to a built launch, the main
process loads *that* renderer — the main checkout — not this branch's build.
The first run did exactly that, and `data-mode` came back `null` because the
main-checkout `index.html` predates the boot script. Every environment listed
above is stripped before launch. Anyone re-running this must strip them too.

Theme walking uses the same `data-theme` + `data-mode` pair
`applyThemeAttributes()` writes. Proven equivalent to the real path first: the
computed token set after stamping the attributes is byte-identical to the set
after writing `appearance.theme` and reloading (`EQUIVALENCE identical`,
checked on `gruvbox`). One caveat found the hard way — attribute stamping does
not re-run React, so any surface that styles from `useResolvedTheme()` in JS
keeps its old paint. The light-theme screenshots below are all taken through
the persisted-setting path for that reason.

---

## Pass 1 — the text ramp and the disabled floor, all nineteen themes

Every theme applied in the running app on the Backlog door; the five ink tokens
and four surface tokens read off the live `:root`. "Ordered" means the ramp runs
strong → default → muted → subtle → disabled monotonically in that theme's own
polarity.

`--text-disabled` contrast, per surface:

| theme | mode | ordered | on `--bg-app` | on `--bg-surface` | on `--bg-surface-raised` | on `--bg-selected` |
|---|---|---|---|---|---|---|
| dark | dark | ok | 3.30 | 3.23 | **3.06** | 2.54 |
| light | light | ok | **2.95** | 3.44 | 3.44 | 2.50 |
| paper | light | ok | 3.07 | 3.29 | 3.38 | 2.34 |
| vellum | light | ok | 3.13 | 3.50 | 3.76 | 2.58 |
| herbarium | light | ok | 3.23 | 3.91 | 4.20 | 2.86 |
| herbarium-dark | dark | ok | 3.29 | 3.15 | **2.86** | 1.68 |
| verdigris | dark | ok | 3.25 | 3.07 | **2.85** | 2.22 |
| slate | dark | ok | 3.29 | 3.13 | **2.81** | 1.61 |
| conifer | dark | ok | 3.40 | 3.13 | **2.99** | 2.15 |
| fernery | dark | ok | 3.43 | 3.11 | **2.78** | 1.79 |
| sage | dark | ok | 3.45 | 3.12 | **2.78** | 1.97 |
| greenhouse | dark | ok | 3.42 | 3.15 | **2.98** | 2.23 |
| caramel | dark | ok | 3.37 | 3.08 | **2.77** | 1.72 |
| lantern | dark | ok | 3.22 | 3.10 | **2.84** | 1.99 |
| aubergine | dark | ok | 3.45 | 3.19 | **2.89** | 1.79 |
| tokyo-night | dark | ok | 3.23 | 3.09 | **2.67** | 1.62 |
| rose-pine | dark | ok | 3.26 | 3.12 | **2.93** | 2.03 |
| ayu-mirage | dark | ok | 3.24 | 3.09 | **2.93** | 2.02 |
| gruvbox | dark | ok | 3.58 | 3.10 | **2.44** | 1.38 |

**Ordering: nineteen of nineteen pass.** No theme inverts a step, in either
polarity. T3's central claim holds and is the strongest thing in this sprint.

**The 3:1 floor on `--bg-surface`: nineteen of nineteen pass** (min 3.07,
verdigris). That is the surface the guard measures, and it is clean.

**On `--bg-surface-raised`: fourteen dark themes fail.** See F4.

`--text-subtle` on `--bg-surface` sits between 3.45 (caramel) and 5.38 (paper);
fifteen themes are under 4.5:1. Not filed as a defect — principles bar
`text.subtle` from carrying actionable copy alone, and it does not here — but
recorded under residual risk.

`--bg-selected-resting` resolves to the **empty string in all nineteen themes**.
See F2.

---

## Pass 2 — selection, per surface

### Backlog door (`1440×900`, dark and light, 211 rows)

| row | fill | left border | selected? |
|---|---|---|---|
| plain row, resting | `#0c0c10` (`--bg-surface`) | transparent | no |
| plain row, selected | `#24242c` (`--bg-selected`) | transparent | **yes** |
| epic-member row, resting | `rgb(23,22,33)` | `3px rgb(167,139,250)` | no |
| epic-member row, selected | `rgb(30,27,43)` | `3px rgb(167,139,250)` | **yes** |

A plain row's selection is a **1.27:1** step. An epic-member row's is
**1.06:1** — and it keeps a 3px purple bar in both states. See F1.

`aria-selected` is correct throughout: exactly one row carries `true`, and it
tracks the click. Selection is never conveyed by fill alone at the semantic
layer. No shadow, no glow, no border box on any row. The T4 accent left bar is
genuinely gone — nothing in the list draws `--accent-primary` as a border.

The ink lift is a no-op: a resting row's title already computes to
`--text-strong` (16.52:1), so "lifts its title to `text.primary`" changes
nothing and the fill carries the whole signal. See F8.

### Multi-pane, three surfaces

| surface | panes rendering `--bg-selected` at full strength, simultaneously |
|---|---|
| Extensions door | sidebar nav (`Extensions`) + rail row (`Featured`) + file tree (`.git`) — **3** |
| New-chat composer | sidebar workspace (`review`) + file tree (`.git`) + `General agent` + `Claude Code` — **4** |
| Settings | sidebar nav + file tree + tab rail (`General`) — **3** |

Every one is `rgb(36,36,44)`. See F2.

### Grayscale

Lifecycle glyphs, the `Missing mockup` warning triangle, and the filled primary
button all survive. The epic/risk colour code does not — every left bar
collapses to the same grey, and the selected epic row becomes indistinguishable
from its unselected neighbour. Screenshot: `32-backlog-grayscale.png`.

---

## Pass 3 — the tab primitive and the four active-state consumers

| surface | how checked | active treatment | verdict |
|---|---|---|---|
| `ui/Tabs.tsx` | rendered, Extensions door tab strip (`Featured / Infrastructure / Payments / Productivity / Data / All`) | label `--text-strong`, inactive `--text-muted`, accent underline strip only; no accent background, no accent label | **pass** — matches `knowledge/brand/primitives.md` and T11's contract |
| Settings tab rail (`role=tab`) | rendered, Settings | `--bg-selected` + `--text-strong` + weight 500; inactive `--text-muted` weight 400 | **pass** |
| `ProjectKnowledgeList` | source (`:287`, `:40`) — Knowledge tab not reachable in the driven profile | `bg-[color:var(--bg-selected)]` + `--text-strong` | **pass**, source-only |
| `NewWorkspacePanel` creation rail | rendered, New Workspace (`Chat / Workspace / Sprint / Design Wizard`) | neutral `--bg-selected` fill, no accent | **pass** |
| `WatchtowerPanel/glyphs` | source (`:79`, `:100`) — panel not reachable without a Watchtower workspace | checked = `--bg-selected` + `--text-strong`; active mark = a 6px dot in `--text-strong`, reads by shape | **pass**, source-only |
| `MockupPreviewPane` | source (`:545`, `:567`, `:821`) — guided-brief flow not reachable | one site `--bg-selected`, **two sites `--bg-surface-raised`** | see F9 |

No element anywhere in the driven surfaces paints `--accent-primary` as a
background except one button per view. See "What passed".

---

## Findings

### F1 — On an epic-member row, selection is invisible; the retired left bar is still drawn under it (critical)

**Location** — Backlog door, `src/renderer/src/utils/backlogTriage.ts:258`
(`resolveBacklogRowColor`), `src/renderer/src/utils/highlight.ts`.
Screenshots `30-striped-selected.png` (dark), `51-light-persisted.png` (light),
`32-backlog-grayscale.png`.

**What I found** — `resolveBacklogRowColor` returns `litFill: true` whenever an
item has a hand-set highlight *or* belongs to a coloured epic, and that fill is
a `color-mix()` tint of the epic hue applied to the whole row. It wins over
`--bg-selected`. Measured on the same list, same click:

```
plain row     #0c0c10 -> #24242c     step 1.27:1     border-left transparent
epic row   rgb(23,22,33) -> rgb(30,27,43)   step 1.06:1   border-left 3px rgb(167,139,250)
```

Selecting an epic-member row changes it by **1.06:1**. In the screenshot, the
selected row `MC-1533` and the unselected `MC-1536` two rows below it are the
same purple block with the same purple bar; nothing on screen says which one
the user picked. In grayscale they are identical. On a stock list, 3 of the 15
visible rows carry the epic tint and 7 carry a coloured bar.

**Why it matters** — This is the primary interaction of the epic's own
reference surface. A user who clicks a row and looks back cannot confirm what
they chose. It also reproduces, verbatim, the composition the T4 mockup labels
as the violation to remove: *"Three panes shouting at once, each with an accent
fill and a left bar… Selection never uses the accent, and never carries a left
bar."* T4 deleted the accent-coloured instance of that pattern and left the
epic-coloured one, which sits on the same rows.

**Recommended fix** — Selection must outrank identity. Either (a) drop the row
fill to the stripe-only treatment `litFill: false` already implements, keeping
identity in the 3px bar and the epic chip, and let `--bg-selected` own the row
background; or (b) keep the tint but composite `--bg-selected` over it so the
selected step is the same magnitude as a plain row's. (a) is smaller and closer
to the mockup, which permits a bar only on a collapsed icon rail — see F3 for
the wider question.

**Owner** — architect (which of (a)/(b), given F3), then frontend.

**Verification** — Backlog door, 1440×900, dark and light: select an
epic-member row and a plain row in turn; the resting→selected contrast step
must be within 10% of each other, and the result must remain distinguishable
under `filter: grayscale(1)`.

### F2 — The resting selection tier was never built, so four panes shout at once (high)

**Location** — `src/renderer/src/assets/index.css` (token absent),
`src/renderer/src/components/ui/InboxRow.tsx` and every multi-pane surface.
Screenshots `20-extensions.png`, `60-sprint-wizard.png`.

**What I found** — `--bg-selected-resting` does not exist. It resolves to the
empty string on `:root` in all nineteen themes, and `grep -rn selected-resting
src/renderer/` returns nothing. The bundle declares
`--sem-color-bg-selected-resting` at `design-system/foundations/tokens.css:47`
and `:134`; the app never aliases it.

The consequence is measurable: the Extensions door renders **three**
full-strength `rgb(36,36,44)` selections at once (sidebar nav, rail row, file
tree); the New-chat composer renders **four**.

**Why it matters** — This is not a missed edge case, it is a named deliverable.
The mockup's "What to change" list reads: *"Add a resting tier:
`bg-[color:var(--bg-selected-resting)]`, title stays `--text-default`. The
variable does not exist yet — dark takes `#1c2024`, light `#e4e8ec`."* The
mockup gives the values. `principles.md` calls the resulting state *"the defect
this rule exists to prevent"*. T4 shipped the half of its mockup the guard
could see (`selection-accent-bar.json` empty) and not the half it could not.

**Recommended fix** — Alias `--sem-color-bg-selected-resting` in the base and
light blocks of `index.css`, add it to `APP_TO_BUNDLE`, then give `InboxRow` a
`restingSelection` variant (fill `--bg-selected-resting`, title stays
`--text-default`) and drive it from whichever pane holds focus on each
multi-pane surface.

**Owner** — architect (this is unfinished T4 scope and needs a task), then
frontend.

**Verification** — Extensions door and the New-chat composer at 1440×900:
exactly one pane paints `--bg-selected`; every other pane's remembered choice
paints `--bg-selected-resting` with its title at `--text-default`. Moving focus
between panes moves which one is full strength.

### F3 — The Backlog list encodes category by colour alone, four hues at once, from hard-coded hexes (high)

**Location** — `src/renderer/src/utils/highlight.ts:95-137`,
`src/renderer/src/utils/backlogTriage.ts:242-262`. Screenshots
`10-backlog-dark.png`, `32-backlog-grayscale.png`.

**What I found** — On one screen of 15 rows, four hues are drawn simultaneously
as 3px left bars: `rgb(167,139,250)` purple, `rgb(48,209,88)` green,
`rgb(255,191,47)` amber, and orange. The palette is hard-coded hex literals
(`#a78bfa`, `#5c7cff`, `#ff7eb3`, …) in `highlight.ts`, outside the token
system. The same epic is encoded three times on one row — the left bar, the row
tint, and the tinted `MC-1540` chip. Where no colour is set by hand, the bar is
**derived risk heat**: a status expressed as a colour category.

**Why it matters** — Three clauses at once. The ceiling *"Product accents
visible per view | 1"* is exceeded fourfold. *"Status hues are not accents:
never a button background, section border, chrome tint, or category code"* —
this is a category code. *"Status reads by shape first, colour second — every
state survives grayscale"* — in grayscale every bar is the same grey and the
encoding conveys nothing. And *"Never hard-code a colour the system defines."*

This is pre-existing, not landed by this sprint. It is filed here because it is
what makes F1 possible and because the sweep in the epic never counted it: the
`selection-accent-bar` rule looks for `--accent-primary`, and these are raw
hexes.

**Recommended fix** — Not mine to invent; it is a product decision about
whether the Backlog keeps a per-epic colour identity at all. The smallest
system-aligned version: keep one identity mark per row (the epic chip, which
already carries the epic's id and survives grayscale), drop the row tint and
the bar, and drop derived risk heat entirely in favour of the existing
difficulty/risk glyph columns.

**Owner** — architect (product decision), then frontend.

**Verification** — Backlog door, 1440×900 and grayscale: at most one product
accent hue is visible in the list, and every distinction a user must make is
still legible with colour removed.

### F4 — `--text-disabled` misses the 3:1 floor on two surfaces the guard does not measure (high)

**Location** — `src/renderer/src/assets/index.css` theme blocks;
`scripts/lint-design-system-conformance.mjs` (`theme-ramp-contrast`).

**What I found** — See the Pass 1 table. Against `--bg-surface-raised`,
**fourteen of nineteen themes** are under 3:1, from gruvbox 2.44 to conifer
2.99. The flagship `light` theme is 2.95 against `--bg-app`. All nineteen clear
the floor on `--bg-surface`, which is the only surface the rule checks.

`--bg-surface-raised` is real chrome, not a theoretical pairing:
`CliModelListbox.tsx:119` paints it and renders 10px
`text-[color:var(--text-disabled)]` inside it at `:133`; `CommandPalette`,
`ConfirmDialog`, `KbdChord` and `SkillPickerPopover` pair the same two tokens.

**Why it matters** — The guard certifies a floor the product does not meet on
the surface where disabled ink most often lands. This is not a regression — T3
lifted every one of these substantially — it stopped exactly where the
measurement stops.

This independently reproduces F3 of `docs/reviews/design-system-conformance-token-layer.md`
by rendered measurement rather than by standalone page, and both agree to two
decimal places. Treat it as confirmation, not a second finding.

**Recommended fix** — Extend `theme-ramp-contrast` to `--bg-surface-raised` and
`--bg-app`, then lift `--text-disabled` in the fourteen themes until all three
clear 3:1.

**Owner** — developer (guard), then frontend (per-theme values).

**Verification** — the guard reports the fourteen themes before the values
change and exits 0 after.

### F5 — Four different focus treatments in one view; two are effectively invisible (medium)

**Location** — Backlog door. Measured by walking `Tab` from the list and
reading `:focus-visible` state on each stop.

**What I found** — Twelve consecutive tab stops, four distinct treatments:

| treatment | controls | contrast on `--bg-app` |
|---|---|---|
| `rgba(63,148,104,0.6) 0 0 0 2px` — the system ring | More actions, Resize sidebar, New chat, New…, Automations | visible |
| `rgba(63,148,104,0.14) 0 0 0 1px` | Collapse sidebar, Search, Back, Forward | **≈1.2:1** |
| `rgba(252,252,252,0.12) 0 0 0 1px` | Move to epic | ≈1.33:1 |
| `outline: 1px auto` (Chromium UA default) | Attach mockup…, Depends on… | not a system token |

`:focus-visible` matched on every stop, and every stop had *something* — which
is why the `focus-ring-removed` rule reads clean. But a 14%-alpha accent
hairline on `#08080c` is not a visible focus indicator, and the whole
top-left navigation cluster uses it.

**Why it matters** — *"Focus is `focus.ring` on `:focus-visible`… Never
suppressed"* and *"Visible focus on everything focusable."* A keyboard user
tabbing into the sidebar loses the caret. T5 restored an outline everywhere the
outline was stripped; it did not converge them on one ring.

**Recommended fix** — One treatment. Alias the bundle's focus ring and route
every `focus-visible:` utility through it; delete the 0.14 and 0.12 variants
and the two UA fallbacks.

**Owner** — frontend.

**Verification** — Tab through the Backlog door at 1440×900 in `dark` and
`light`: every stop draws the identical ring, and it clears 3:1 against the
surface behind it.

### F6 — The Backlog detail pane clips at 1024px wide, with no scrollbar (medium)

**Location** — Backlog door detail pane. Screenshots
`35-backlog-1024x768.png`, `35-backlog-390x844.png`.

**What I found** — At **1024×768** the detail pane's header and body extend to
`x = 1301` in a 1024px viewport while `document.scrollWidth === clientWidth` —
so the overflow is clipped, not scrollable. The item title reads *"SDK:
module-defined command scopes, av… and p"* against the window edge, and the
markdown code chips are sliced mid-word (`panel:wat`, `Workspace`,
`conflicts`). At **390×844** the `New item` primary action is cut off at
`x = 414`. At 768×1024 only the agent tab bar overflows (24px).

**Why it matters** — 1024×768 is an ordinary window size for a desktop app, not
an edge case, and content is lost silently: there is no scrollbar to tell the
user something is off-screen.

**Recommended fix** — Give the detail pane `min-width: 0` on its flex chain so
it shrinks with the surface, and let its prose wrap rather than pushing the
container.

**Verification** — Backlog door at 1024×768 and 900×700 with an item selected:
`document.scrollWidth === clientWidth` and no element's `right` exceeds
`innerWidth`.

**Owner** — frontend.

### F7 — Interactive controls below the 24px hit-target minimum (medium)

**Location** — file explorer header, workspace sidebar, door bar, agent tab bar.

**What I found** — `--sem-size-hit-target-min` is 24px. Measured bounding
boxes: `Folder actions: mc-review-ws` 20×20, `Workspace actions` 20×20,
`Close review` 20×20, `Back` 22×22, and the flexlayout tab toolbar buttons
14×14.

**Why it matters** — *"Nothing interactive is drawn below
`sem.size.hit-target-min`. A small glyph pads out to it with a transparent hit
area rather than shrinking its target."* Three of these are destructive or
navigational.

**Recommended fix** — Keep the glyphs at their drawn size and pad the button to
24×24 with a transparent hit area. The flexlayout ones need a wrapper, since
the library owns that markup.

**Owner** — frontend.

**Verification** — every `button` / `[role=button]` in the workspace shell
measures ≥24px on both axes at 1440×900.

### F8 — The ink lift on selection is a no-op (low)

**Location** — `src/renderer/src/components/ui/InboxRow.tsx`.

**What I found** — A resting Backlog row's title already computes to
`--text-strong` (`rgb(236,236,236)`, 16.52:1). The selected row's title is the
same value, so "lifts its title to `text.primary`" is a no-op and the fill is
the only channel carrying selection.

**Why it matters** — Alone this is cosmetic. Combined with F1 it is why an
overpainted fill leaves nothing behind: there is no second signal.

**Recommended fix** — Land it with F2. Once the resting tier exists the ramp is
`--text-default` resting → `--text-strong` focused, and the lift becomes real —
which requires unselected titles to sit at `--text-default`, not at
`--text-strong`.

**Owner** — frontend.

**Verification** — an unselected row title reads `--text-default`; selecting it
moves the title to `--text-strong`.

### F9 — `MockupPreviewPane` marks two active states with `--bg-surface-raised`, not `--bg-selected` (low)

**Location** — `src/renderer/src/components/workspace/guidedBrief/MockupPreviewPane.tsx:545`,
`:567`. Source-only: the guided-brief flow is not reachable in the driven
profile.

**What I found** — One active state in the file uses `--bg-selected` (`:821`),
two use `--bg-surface-raised`. T11's contract for the four consumers is
*"active state is `--bg-selected` with an ink lift"*.

**Why it matters** — Small, but it is a third selection tone in a product that
is trying to converge on two, and it is the one consumer of the four I could
not confirm by rendering.

**Recommended fix** — `--bg-selected` at both sites.

**Owner** — frontend.

**Verification** — open the guided-brief mockup preview and confirm the active
segment paints `--bg-selected`.

---

## What passed

Recorded because a check that found nothing is evidence too. All rendered in
the built app unless noted.

| Check | Result |
|---|---|
| Text-ramp ordering, nineteen themes | **Clean.** No inversion in either polarity. |
| `--text-disabled` ≥3:1 on `--bg-surface`, nineteen themes | **Clean.** Min 3.07 (verdigris). |
| `backdrop-filter` on overlay chrome (T7) | **None**, on any surface driven — including the command palette, whose separation comes from the scrim alone. |
| Accent marking active state (T11) | **None.** Zero elements paint `--accent-primary` as a background outside the one primary button per view. |
| One solid accent per view | **Clean.** `New item` only, dark (`rgb(63,148,104)` on `rgb(8,8,12)`) and light (`rgb(47,106,74)` on white). |
| Micro-type floor (T12) | **Clean.** No rendered text below 10px on any surface. The smallest is the 10px epic chip, exactly at the floor. |
| Uppercase letter-spaced chrome (T9) | **None.** No element combines `text-transform: uppercase` with positive tracking. Section headers read `Marketplace`, `On this machine`, `Ready to launch` — sentence case throughout. |
| Emoji as iconography (T8) | **None** in rendered UI strings across Backlog, Extensions, Settings, the composer and the creation flow (terminal output excluded). |
| Status in grayscale | **Clean** for lifecycle glyphs, the `Missing mockup` warning and the primary button. Fails only for the F3 colour code. |
| `z-index` outside the scale | **Clean.** The only offender is xterm's internal `-5` helper textarea, third-party and non-visual. |
| Shadow on an in-flow element (T7) | **Effectively clean.** Every hit is either Tailwind's transparent shadow reset or the flexlayout tabset's `inset 0 0 0 1px rgba(252,252,252,0.06)`, which is a hairline drawn as a ring, not elevation. |
| Row rhythm (T10) | **Clean.** Backlog rows are a uniform 49px with `6px/12px` padding — on the 2px grid, consistent across all 211. |
| `aria-selected` correctness | **Clean.** Exactly one row `true`, tracking the click, on every list checked. |
| Selection carrying a border box, glow or shadow | **None.** |

---

## Residual risk — what this review did not establish

- **Three of the four T11 consumers were confirmed by rendering, one by source
  only.** `ProjectKnowledgeList`, `WatchtowerPanel/glyphs` and
  `MockupPreviewPane` need a Knowledge-configured workspace, a Watchtower
  workspace and the guided-brief flow respectively; none exists in the
  throwaway profile. Their source is unambiguous, but no pixel was inspected.
- **`--text-disabled` is under 3:1 on `--bg-selected` in all nineteen themes**
  (1.38 gruvbox → 2.86 herbarium). I found no surface that actually pairs them
  in the app I drove, so this is filed as a risk, not F4's defect. If any
  surface renders disabled ink inside a selected row, it fails.
- **`--text-subtle` is under 4.5:1 on `--bg-surface` in fifteen themes**
  (3.45 caramel → 4.34 vellum). Permitted while it carries only non-actionable meta, which is
  the case in every row inspected. It is one product decision away from being a
  defect.
- **One theme walked, nineteen measured.** Screenshots exist per theme, but the
  per-surface *judgement* passes (selection, tabs, overlays, responsive) were
  run in `dark` and re-confirmed in `light` only. A theme-specific layout defect
  would not be caught.
- **Alpha and `color-mix()` borders are unmeasured for contrast** — the same
  limit the token-layer review records.
- **Sprint board not reviewed.** The epic names Backlog *and* the Sprint board
  as the reference standard. The board needs a live run bound to the workspace,
  which the throwaway profile cannot provide; the run directory copied in
  renders no board. Findings F1–F3 concern `InboxRow` and the shared token
  layer, so they carry to the board by construction, but that is inference.
- **Out of scope by the task card, and still open:** per-surface information
  architecture — density, chrome budget, state coverage, empty/loading/error
  treatments, copy. One thing seen in passing and left unfiled: in the Backlog
  detail pane the item's own title renders at 14px while its markdown body's H1
  renders at ~28px, so the content outranks the item. That belongs to the
  epic's second pass.
