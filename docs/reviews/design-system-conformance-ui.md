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

## Pass 4 — glyph replacements in grayscale, per site

T8 replaced emoji at fourteen sites across eight files. Each is recorded below
with how it was checked. `filter: grayscale(1)` applied to the live document,
then screenshotted and re-scanned for emoji codepoints in rendered text.

| T8 site | how checked | outcome |
|---|---|---|
| `ui/CliModelListbox.tsx` | **rendered**, composer with the CLI/model tree open, grayscale (`71-cli-listbox-gray.png`) | **pass.** Each CLI header carries a distinct AppIcons glyph (Claude Code, Codex, Cursor, Grok Build) — four different shapes, legible with colour removed. The chosen CLI is `--bg-selected` plus a check mark: two shape-based signals, no colour dependency. Model ids in mono, right-aligned. |
| `ui/WizardProgress.tsx` | **rendered**, creation wizard header (`72-wizard-gray.png`) | **pass.** Progress reads as a filled/unfilled bar, no emoji, no colour-only step state. |
| `workspace/NewWorkspacePanel` creation rail | **rendered** (`03-post-onboarding.png`) | **pass.** `Chat / Workspace / Sprint / Design Wizard` each carry a distinct glyph; the active row is a neutral fill. |
| `backlog/RosterMenu.tsx` | source | **pass.** No emoji codepoint in the file. |
| `newWorkspace/SprintEngineRosterPanel.tsx` | source — sprint creation flow not reachable in the driven profile | **pass.** No emoji codepoint. |
| `newWorkspace/SprintEngineRosterTable.tsx` | source — same | **pass.** No emoji codepoint. |
| `newWorkspace/SprintEngineProjectPanel.tsx` | source — same | **pass.** No emoji codepoint. |
| `guidedBrief/GuidedBriefFlow.tsx` | source — guided-brief flow not reachable | **pass.** Only `→` in code comments. |
| `panels/AgentChatView.tsx` | source — needs a live chat agent | **pass with a note.** The only two emoji-range codepoints left anywhere in `src/renderer` are at `:3858` and `:3874`, and both are a `✓` inside a regex that colours *agent command output* — content T8 explicitly excludes. Separately `:2077` renders `↓ N new replies`; `↓` is a text arrow, not an emoji, and it sits beside its own label. |

**Whole-renderer scan:** across every `.ts`/`.tsx` under `src/renderer/src`,
exactly **two** lines contain an emoji-range codepoint, both the agent-output
`✓` above. Rendered-text scans on Backlog, Extensions, Settings, the composer
and the creation wizard returned **zero** emoji.

One a11y gap surfaced by the same sweep and folded into F7 rather than filed
separately: four 12×12 `svg` marks render with neither an accessible name nor
`aria-hidden`, two of them inside focusable buttons. All four are flexlayout's
tab-close and tab-toolbar controls — third-party markup, and the same controls
F7 measures at 14×14.

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

Two of the flexlayout controls compound it: they are icon-only 12×12 `svg`
marks inside focusable buttons with **neither an accessible name nor
`aria-hidden`**, so a screen reader announces an unlabelled button.

**Why it matters** — *"Nothing interactive is drawn below
`sem.size.hit-target-min`. A small glyph pads out to it with a transparent hit
area rather than shrinking its target."* and *"`aria-label` on every icon-only
button."* Three of these are destructive or navigational.

**Recommended fix** — Keep the glyphs at their drawn size and pad the button to
24×24 with a transparent hit area, and give the two flexlayout controls an
`aria-label`. The flexlayout ones need a wrapper, since the library owns that
markup.

**Owner** — frontend.

**Verification** — every `button` / `[role=button]` in the workspace shell
measures ≥24px on both axes at 1440×900, and every icon-only button reports a
non-empty accessible name.

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
- **Six of the fourteen T8 glyph sites were verified rendered in grayscale; six
  by source.** The sprint-creation panels, the guided-brief flow and
  `AgentChatView` need a sprint, a brief and a live chat agent respectively.
  The whole-renderer emoji scan covers them, but only source-deep: a glyph that
  is present yet illegible in grayscale at those sites would not be caught.
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

---

# Re-check — 2026-07-29 (T23)

Task T23. Under re-check: the eight findings T18–T22 claim to have fixed (F1,
F2, F4, F5, F6, F7, F8, F9), each re-measured by its own verification step in
the built app. **F3 is deliberately not adjudicated here** — it is an open owner
decision. It is reported as observed, unchanged, and left where T13 left it.

Verdict: **five of eight cleared.** F1, F2, F4, F6 and F9 are done. F5 and F7
moved a long way and stop short of the bar their own findings set. F8 was fixed
in the file it was filed against and not on the surface it was measured on.
Three new findings, R1–R3, are filed below.

The T21 retone carries a separate charge and it comes back clean: in all ten
retoned themes the ink stayed on the theme's own hue and metadata still reads
below body text.

## Method

Same harness as the original review and the same traps. Built from this branch
(`npm run build`, `out/main/index.js`), driven through Playwright `_electron` on
an isolated profile (`MULTICODE_USER_DATA_DIR`, `MULTICODE_ALLOW_MULTI_INSTANCE=1`),
`ELECTRON_RENDERER_URL` / `NODE_ENV_ELECTRON_VITE` / `NODE_ENV` stripped before
launch and `data-mode` asserted non-null before any number is read. Workspace
under test: a throwaway copy of this repo's `backlog/` (205 rows), the same
surface T13 measured. Colour is resolved through a 1×1 canvas and contrast is
WCAG 2.1 relative luminance, so every "after" below is on the same scale as the
"before" beside it.

**Two traps of this pass's own, recorded because each produced a false finding
before it was caught.**

1. *The narrow viewport silently clamps.* The main window carries
   `minWidth: 800` (`src/main/window-factory.ts:76`), so `setContentSize(390, …)`
   returns an **800px** viewport and reports success. A 390×844 result taken
   that way is measuring a viewport twice the width it names. Call
   `setMinimumSize(1, 1)` first, and assert the achieved `clientWidth` equals
   the requested one.
2. *An element past the right edge is not necessarily clipped.* Thirteen
   elements extend beyond `innerWidth` at 1024×768 with an item selected. All
   thirteen sit inside a horizontal scroll container — a markdown table that
   scrolls, which is correct behaviour. The bare `right > innerWidth` test that
   F6 is written around reports these as defects. Walk up for a scrollable
   ancestor before believing it.

A third, mine alone: the pre-T21 ink values must be read out of the theme blocks
of the T13-era `index.css`, per theme. Reading them off a `git diff` hunk list
scrambles the theme-to-value mapping and manufactures 30–180° of hue drift that
did not happen.

## Verdicts

| finding | before (T13) | after (T23) | verdict |
|---|---|---|---|
| F1 selection under an identity tint | epic row steps 1.06:1 vs a plain row's 1.27:1; identical in grayscale | 1.162 vs 1.268 dark (8.4% apart), 1.275 vs 1.379 light (7.5%); 1.276:1 / 1.385:1 vs neighbour in grayscale | **cleared** |
| F2 the resting selection tier | token empty in 19/19; 3 full-strength panes on Extensions, 4 on the composer | token resolves in 19/19; **1** full + 3 resting on Extensions, **1** full + 3 resting on the composer | **cleared** |
| F3 colour-alone category code | 4 hues at once, hard-coded hexes | unchanged — 101 coloured bars and 43 tinted rows on one 205-row list | *not adjudicated — owner's* |
| F4 the disabled floor | 14 themes under 3:1 on `--bg-surface-raised`; `light` 2.95 on `--bg-app` | 19/19 clear 3:1 on all three surfaces; rendered ink clears 3.23–4.10:1 | **cleared** |
| F5 four focus treatments | 4 treatments, two at ≈1.2:1 and ≈1.33:1 | 30 of 33 stops on one 2px ring at 4.76–5.38:1; **3 stops still on the UA outline**, and the door search field draws no ring at all | **partly — see R1** |
| F6 the detail pane clips at 1024px | content to `x = 1301`, no scrollbar | **0** clipped at 1024×768, 900×700 and 768×1024; 390×844 still clips but is below the window's own 800px minimum | **cleared** in range |
| F7 sub-24px hit targets | 20×20, 22×22, 14×14; 2 unlabelled `svg` in focusable buttons | every named site fixed; **0** unnamed controls on four surfaces; **12 controls still under 24px** | **partly — see R2** |
| F8 the ink lift is a no-op | resting and selected titles both `--text-strong` | `InboxRow` now lifts; **the Backlog door does not use `InboxRow`** and its title is still `--text-strong` in both states | **not cleared — see R3** |
| F9 `MockupPreviewPane` active state | 2 sites on `--bg-surface-raised` | both `:545` and `:567` now `--bg-selected` + `--text-strong`, matching `:821` | **cleared** (source) |

## Per finding

### F1 — cleared

Measured on the real list, dark and light, selecting a plain row and an
identity-tinted row in turn:

```
dark    plain     rgb(12,12,16)  -> rgb(36,36,44)   step 1.268:1
dark    tinted    rgb(23,22,33)  -> rgb(36,36,44)   step 1.162:1     8.4% apart
light   plain     rgb(255,255,255) -> rgb(216,220,224)  step 1.379:1
light   tinted    rgb(246,245,255) -> rgb(216,220,224)  step 1.275:1  7.5% apart
```

Both inside the 10% bar F1 set; the gap was 16% before. In grayscale the
selected tinted row now stands off its unselected neighbour by 1.276:1 (dark)
and 1.385:1 (light) where it was previously indistinguishable. The fix is paint
order — `backlogRowPaintClass` drops the identity fill on the selected row and
paints `--bg-selected` — so a selected row lands on the token whatever colour it
carries, which is why both steps converge on the plain row's.

Identity keeps its other channels: the 3px bar is still drawn in both states
(`3px rgb(167,139,250)` on the measured row). That is F3's business, not F1's.

### F2 — cleared

`--bg-selected-resting` resolves in all nineteen themes (`#1c2024` dark,
`#e4e8ec` light) where it was the empty string in all nineteen. Counting panes
that paint a selection at full strength simultaneously:

| surface | before | after |
|---|---|---|
| Extensions door | 3 full | **1** full + 3 resting |
| New-chat composer | 4 full | **1** full + 3 resting |

The ink half is live too: with focus in another pane, the sidebar's active
workspace row carries `aria-current="true"` and draws its title at
`--text-default`, not `--text-strong` — the resting tier dropping the lift back
out, which is exactly the ramp F8 described.

### F3 — unchanged, and left alone

Confirmed present and untouched, as the task requires: on one 205-row list, 101
rows carry a coloured 3px left bar and 43 carry the epic tint, from the same
hard-coded hexes in `highlight.ts`. No judgement recorded here.

### F4 — cleared

`--text-disabled` contrast per surface, T13's number → this pass's:

| theme | on `--bg-app` | on `--bg-surface` | on `--bg-surface-raised` |
|---|---|---|---|
| dark | 3.30 → 3.30 | 3.23 → 3.23 | 3.06 → **3.06** |
| light | 2.95 → 3.07 | 3.44 → 3.58 | 3.44 → **3.58** |
| paper | 3.07 → 3.07 | 3.29 → 3.29 | 3.38 → **3.38** |
| vellum | 3.13 → 3.13 | 3.50 → 3.50 | 3.76 → **3.76** |
| herbarium | 3.23 → 3.23 | 3.91 → 3.91 | 4.20 → **4.20** |
| herbarium-dark | 3.29 → 3.65 | 3.15 → 3.49 | 2.86 → **3.17** |
| verdigris | 3.25 → 3.61 | 3.07 → 3.41 | 2.85 → **3.17** |
| slate | 3.29 → 3.69 | 3.13 → 3.52 | 2.81 → **3.15** |
| conifer | 3.40 → 3.61 | 3.13 → 3.32 | 2.99 → **3.17** |
| fernery | 3.43 → 3.79 | 3.11 → 3.43 | 2.78 → **3.08** |
| sage | 3.45 → 3.85 | 3.12 → 3.49 | 2.78 → **3.11** |
| greenhouse | 3.42 → 3.61 | 3.15 → 3.33 | 2.98 → **3.15** |
| caramel | 3.37 → 3.79 | 3.08 → 3.47 | 2.77 → **3.12** |
| lantern | 3.22 → 3.63 | 3.10 → 3.49 | 2.84 → **3.20** |
| aubergine | 3.45 → 3.66 | 3.19 → 3.38 | 2.89 → **3.06** |
| tokyo-night | 3.23 → 3.84 | 3.09 → 3.68 | 2.67 → **3.18** |
| rose-pine | 3.26 → 3.46 | 3.12 → 3.31 | 2.93 → **3.11** |
| ayu-mirage | 3.24 → 3.43 | 3.09 → 3.27 | 2.93 → **3.10** |
| gruvbox | 3.58 → 4.73 | 3.10 → 4.09 | 2.44 → **3.22** |

**Nineteen of nineteen clear 3:1 on all three surfaces**, from fourteen failing
on `--bg-surface-raised` and one on `--bg-app`. Ramp ordering survives the
retone: nineteen of nineteen still run strong → disabled monotonically.

Measured a second way, because a token pair is not a rendered pairing: with the
CLI/model listbox open — the surface T13 named, `--bg-surface-raised` chrome
with 10px disabled ink inside it — every element actually painted in
`--text-disabled` was read against the fill actually behind it. Five sites per
theme, worst 3.23:1 (`dark`), best 4.10:1 (`gruvbox`). Nothing under the floor.

### F5 — partly cleared

Thirty-three tab stops walked across the Backlog door and the workspace shell.
**Thirty draw one ring**, `0 0 0 2px var(--border-focus)` = `rgb(63,148,104)`,
at **4.76–5.38:1** against the surface behind it. The 14%- and 12%-alpha
hairlines T13 measured at ≈1.2:1 and ≈1.33:1 are gone, and the whole top-left
navigation cluster — Collapse sidebar, Search, Back, Forward — is on the system
ring. `Attach mockup…` and `Depends on…`, T13's two UA-outline stops, are fixed.
Counting the `ring-inset` variant as a second treatment would be wrong: same
colour, same width, drawn inside so a scroll container does not clip it.

Three stops are not, and one control has no ring at all. See **R1**.

### F6 — cleared inside the window's own size range

At a genuinely achieved 1024×768, 900×700 and 768×1024, with an item selected:
`document.scrollWidth === document.clientWidth` at every one, and every element
extending past the right edge sits inside a horizontal scroll container — 13 at
1024×768, 14 at 768×1024, **0 clipped** at either. At 900×700 nothing crosses
the edge at all. The detail pane now shrinks with the surface and the title
wraps instead of being sliced; the wide markdown table that used to push the
container scrolls inside its own.

**390×844 still clips, and is unreachable.** Eight elements — a top-bar button,
the `Paused` chip, a count badge, the `Epic` picker — sit at `right` 391–412 in
a 390px viewport with no scrollable ancestor. But the main window declares
`minWidth: 800` (`src/main/window-factory.ts:76`), so that viewport only exists
if a harness calls `setMinimumSize(1, 1)` first — `setContentSize(390, …)` alone
returns 800px and reports success. A user cannot make the window that narrow.

Recorded, not filed: the clipping is real but sits outside the window's own
declared contract, and 800px — the narrowest a user can actually reach — is
clean. If the product ever means to support a phone-width viewport, the 800px
minimum is the thing to change first and this becomes a defect; until then the
honest reading is that F6's third viewport tests a size the app does not offer.

### F7 — partly cleared

Every site T13 named is fixed. The flexlayout 14×14 tab controls are gone, the
Extensions door measures clean, and across four surfaces — Backlog door,
workspace shell, Extensions door, new-chat composer — **not one interactive
control reports an empty accessible name**, which closes the unlabelled-`svg`
half of the finding outright.

Twelve controls still measure under 24px. See **R2**.

### F8 — not cleared

`InboxRow` does now carry the lift: `--text-default` resting, `--text-strong`
selected (`InboxRow.tsx:73`). But the Backlog door does not render `InboxRow` —
it renders `BacklogRowContent`, whose title is hard-coded
`text-[color:var(--text-strong)]` at `BacklogRow.tsx:239` and `:247` regardless
of selection. Measured on the door, both themes, both a plain and a tinted row:

```
dark    title  rgb(236,236,236) -> rgb(236,236,236)     (--text-default is rgb(200,200,208))
light   title  rgb(32,36,40)    -> rgb(32,36,40)        (--text-default is rgb(60,68,76))
```

Unchanged from T13. See **R3**.

### F9 — cleared, by source

`MockupPreviewPane.tsx:545` and `:567` both now read
`bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]`, matching
`:821`. Every remaining `--bg-surface-raised` in the file is a `hover:` state or
a `Skeleton`. Source-only, for the same reason as the original: the guided-brief
flow is still not reachable in the driven profile.

## The T21 retone, looked at

T21 could not clear 3:1 on `--bg-surface-raised` by moving `--text-disabled`
alone, so it also lifted `--text-subtle` in ten themes and `--text-muted` in
two. That lightens metadata ink. Two questions the lint cannot answer:

**Did the ink keep the theme's hue, or drift grey?** Each before/after pair
converted to OKLCH:

| theme | `--text-subtle` | hue drift | chroma retained | lightness |
|---|---|---|---|---|
| aubergine | `#7c708c` → `#807490` | 0.0° | ×0.996 | 0.566 → 0.580 |
| ayu-mirage | `#747884` → `#787c88` | 0.0° | ×0.995 | 0.573 → 0.587 |
| caramel | `#7c7054` → `#887c60` | 0.0° | ×0.986 | 0.549 → 0.590 |
| conifer | `#6c786c` → `#707c70` | 0.0° | ×0.996 | 0.559 → 0.573 |
| gruvbox | `#907868` → `#a48c7c` | 0.1° | ×0.971 | 0.591 → 0.657 |
| lantern | `#7c6c54` → `#84745c` | 0.0° | ×0.990 | 0.540 → 0.567 |
| rose-pine | `#806c78` → `#84707c` | 0.0° | ×0.993 | 0.554 → 0.568 |
| sage | `#808060` → `#888868` | 0.0° | ×0.991 | 0.591 → 0.618 |
| slate | `#7c7c7c` → `#808080` | — | achromatic before *and* after | 0.586 → 0.600 |
| tokyo-night | `#6c7090` → `#787c9c` | 0.1° | ×0.982 | 0.554 → 0.595 |

**No.** Every retone is a pure lightness lift along the theme's own hue line:
drift never exceeds 0.1°, chroma is retained at ×0.971–0.996. `slate` shows
chroma 0 on both sides because slate's whole ramp is neutral by design
(`#e8e8e8 / #cccccc / #9c9c9c / #808080 / #787878`) — it did not go grey, it was
already grey, and its identity is that neutrality. The two `--text-muted` moves
behave the same: tokyo-night `#707898` → `#8088a8` (0.1° drift, ×0.978),
ayu-mirage `#7c8088` → `#848890` (0.0°, ×0.992).

Confirmed by eye rather than by number: all ten rendered on the Backlog door at
1440×900 and each inspected as a native-resolution crop of the metadata strip.
gruvbox reads warm tan on brown-black, caramel warm cream, lantern gold-brown,
sage and conifer olive-green, tokyo-night and ayu-mirage cool blue, aubergine
violet, rose-pine mauve, slate neutral. Each is unmistakably itself.

One caveat on the method, since the whole judgement rests on it: a downscaled
full-window screenshot is not safe to read hue from — at thumbnail scale
caramel's warm cream ink reads cool, and reading it that way would have
manufactured a drift finding. Every hue call above is from a 1:1 crop.

**Does metadata still read as secondary to body text?** `--text-subtle` against
`--text-default`, before → after:

```
lantern 2.98 -> 2.66     caramel 2.93 -> 2.48     slate 2.60 -> 2.46
gruvbox 2.51 -> 1.93     sage    2.48 -> 2.22     rose-pine 2.45 -> 2.31
conifer 2.22 -> 2.10     aubergine 2.12 -> 2.00   ayu-mirage 2.01 -> 1.90
tokyo-night 2.03 -> 1.72
```

**Yes, in all ten**, and `--text-subtle` stays separated from `--text-muted`
above it everywhere. The step compresses — gruvbox most (2.51 → 1.93),
tokyo-night lowest in absolute terms (1.72:1) — and on those two the row id and
timestamp are visibly more present than in an untouched dark theme. They still
read as a lower tier: the title sits at `--text-strong` and carries a weight
step (medium vs normal) on top of the ink step, and nothing in the ten reads as
metadata competing with the title. Not filed. Recorded as the closest thing in
this sprint to a hierarchy cost, and the tier that a further lift would break.

## New findings

### R1 — Three controls still fall back to the Chromium UA outline, and the door search field draws no ring at all (medium)

**Location** — `src/renderer/src/components/ui/InboxSearchInput.tsx:26-31`
and `:47-54`; `src/renderer/src/components/panels/BacklogPanel.tsx:2450`,
`:2863`; `src/renderer/src/components/backlog/BacklogLinksSection.tsx:173`.

**What I found** — Of thirty-three tab stops, thirty draw the system ring. The
other three draw `outline: rgb(229,151,0) 1px auto` — Chromium's UA default,
inherited because the button declares no focus treatment at all: the search
field's `Clear search`, the detail pane's `Open epic …` breadcrumb, and a
linked-item button in the Links section. `BacklogPanel.tsx:2863` is a fourth of
the same shape.

Separately, and worse: the door search **input** has `outline-none` and no ring.
Its only focus signal is the wrapper's border going from `--border-default`
(`rgba(252,252,252,0.08)`, a near-invisible hairline) to `--accent-primary` at
**1px** via `focus-within`. That is a hue-only change on a hairline, at half the
system ring's width, and it reaches for `--accent-primary` where every other
control reaches for `--border-focus` — the two happen to resolve to the same
green in `dark`, so the substitution is invisible until a theme separates them.
`InboxSearchInput` is the shared search chrome on every door rail, so this is on
Backlog, Extensions, Sprints and Reviews alike, not one screen.

**Why it matters** — T22's own contract is one focus treatment. The UA outline
is not a token: it is drawn by the platform, it changes with the OS and the
Chromium version, and it is the one treatment the design system cannot theme.
The search field is the entry point to filtering a door; a 1px hairline shifting
hue is a weaker signal than the 2px ring every neighbouring control draws, and a
keyboard user moving between them sees the indicator change shape.

This is a real improvement over T13 — the two effectively-invisible alpha
treatments are gone, and the three surviving UA outlines measure 7.71–8.14:1,
where T13's worst treatments sat at ≈1.2:1 — but the finding as written is not
closed. The search field's border was measured for width and colour, not for
contrast.

**Recommended fix** — Add `FOCUS_RING_CLASS` to the four ringless buttons. In
`InboxSearchInput`, move the ring onto the wrapper (`focus-within:` the system
ring) and drop the `focus-within:border-[color:var(--accent-primary)]`, so the
field gets the same 2px `--border-focus` ring as everything else and the accent
goes back to being used once per view.

**Owner** — frontend.

**Verification** — Tab through the Backlog door with the search field non-empty,
at 1440×900 in `dark` and `light`: every stop, the search input and its clear
button included, reports a `box-shadow` ring in `--border-focus`, and no stop
reports `outline-style: auto`.

### R2 — Twelve controls are still drawn under the 24px hit-target floor, and nothing guards it (medium)

**Location** — `src/renderer/src/components/workspace/WorkspaceIdentity.tsx:181`
(`h-[22px] w-[22px]`) and `:237`; `src/renderer/src/components/ui/InboxSearchInput.tsx:47`;
`src/renderer/src/components/workspace/agentComposer/AgentComposer.tsx:164`,
`:319`, `:358`; `src/renderer/src/components/workspace/agentComposer/agentSpawnShared.tsx:240`.

**What I found** — Every site T13 named is fixed, and the accessible-name half
of F7 is fully closed. Measuring every visible, enabled `button` /
`[role=button]` / `[role=tab]` / `[role=menuitem]` across four surfaces at
1440×900 still returns twelve under 24px on an axis:

| surface | controls |
|---|---|
| title bar | `Star workspace` 22×22, `Toggle file explorer` 90×22 |
| Backlog door | `Clear search` **10×10** |
| new-chat composer | `Close` 22×22, `+ Skill` 51×23, `+ Connector` 86×23, the workspace picker 108×23, and the five reasoning/mode chips at 21px tall |

None of these is a regression — the composer chips carried `py-0.5` at T13 time
too. They are the same rule failing in places the hand-fix did not reach, and
`scripts/lint-design-system-conformance.mjs` has **no hit-target rule at all**,
so nothing prevents the next one.

`Clear search` at 10×10 is the sharpest: it is under half the floor, it is the
control that undoes a filter, and it is on every door rail.

**Why it matters** — *"Nothing interactive is drawn below
`sem.size.hit-target-min`. A small glyph pads out to it with a transparent hit
area rather than shrinking its target."* A 10×10 target is a miss-and-retry for
a trackpad user and a real barrier for anyone with a motor impairment.

**Recommended fix** — Pad each to 24×24 with a transparent hit area, keeping the
drawn glyph and the chip's visual height where the density demands it (the
composer chips can keep their 21px paint and take `py-1.5` on the button). Then
add a `hit-target-min` rule to the guard so the floor is measured, not
remembered — it is the only one of T13's findings with no mechanical backstop.

**Owner** — frontend (padding), then developer (guard).

**Verification** — every visible enabled `button` / `[role=button]` on the
workspace shell, the Backlog and Extensions doors and the new-chat composer
measures ≥24px on both axes at 1440×900, and the guard reports the twelve before
the change and exits 0 after.

### R3 — The ink lift landed in `InboxRow`; the Backlog door does not use `InboxRow` (low)

**Location** — `src/renderer/src/components/backlog/BacklogRow.tsx:239`, `:247`;
`src/renderer/src/components/workspace/globalSurface/backlog/BacklogGlobalSurface.tsx:982`;
`src/renderer/src/components/panels/BacklogPanel.tsx`.

**What I found** — F8 was filed with `InboxRow.tsx` in its Location line and
measured on a Backlog row. T18 fixed `InboxRow`, which now ramps
`--text-default` → `--text-strong` correctly. The Backlog door renders
`BacklogRowContent` inside its own `<li role="option">`; that component's title
is `text-[color:var(--text-strong)]` unconditionally. Re-measured on the door in
both themes, both a plain and a tinted row, the title ink is byte-identical
resting and selected. F8's stated verification — *"an unselected row title reads
`--text-default`; selecting it moves the title to `--text-strong`"* — does not
pass on the surface it was written for.

**Why it matters** — Low on its own, and lower than when T13 filed it: F1 is
fixed, so the fill now carries a proper 1.27:1 step and selection is no longer
invisible. But F8's argument was that selection should not depend on a single
channel, and on the Backlog door it still does. It also means the resting tier
F2 built cannot express itself on this surface: a Backlog row in a pane that
does not hold focus drops its fill to `--bg-selected-resting` while its title
stays at full strength, so the two halves of the tier disagree.

**Recommended fix** — Give `BacklogRowContent` the same conditional the
`InboxRow` comment describes: `--text-default` unselected, `--text-strong`
selected, driven from the `selected` flag the row already computes for
`backlogRowPaintClass`. Both Backlog surfaces render through that one component,
so it is a single edit.

**Owner** — frontend.

**Verification** — Backlog door and Backlog panel at 1440×900, `dark` and
`light`: an unselected row title computes to `--text-default` and selecting it
moves it to `--text-strong`; on a pane that does not hold focus, a row at
`--bg-selected-resting` keeps its title at `--text-default`.

## What this re-check did not establish

- **F3 is untouched and unjudged**, by instruction. Everything F1 leaves in
  place — the 3px bar, the tint on unselected rows, the derived risk heat —
  still stands or falls on that decision.
- **F9 is source-only, again.** The guided-brief flow is still unreachable in a
  throwaway profile, so both corrected sites were read, not rendered.
- **The retone was judged on one surface.** All ten themes were viewed on the
  Backlog door — timestamps, row ids, size letters, project tags — and disabled
  ink was measured on the CLI/model listbox. Disabled *menu* items in an open
  menu were measured by token, not screenshotted per theme.
- **F5 and F7 were swept by tab-walk and by DOM measurement on four surfaces**,
  not on every surface in the product. Both counts in R1 and R2 are floors, not
  totals; the Sprint board, Settings, Reviews and the guided-brief flow were not
  measured.
- **Nineteen themes measured, two walked.** The per-surface judgement passes
  (selection, focus, hit targets, responsive) ran in `dark` and were
  re-confirmed in `light`, as before.
- **The sprint board is still not reviewed**, for the same reason as the
  original: the throwaway profile cannot bind a live run.

---

# Integration re-check — 2026-07-29 (T24)

Task T24. T15 drove the conformance guard to zero tolerance across T2–T12 and
then completed; T18–T22 landed after it, so that proof no longer covered the
tree. This is the replacement integration pass, scoped to the fix batch and the
seams it crossed — not a redo of T15, and not a redo of T23's per-finding
re-check.

Verdict: **three of five acceptance criteria met.** The guard, the suite and
both shared seam files are clean. The two live-behaviour criteria are not met:
the resting selection tier does not reach the Backlog door at all, and four of
seventy-four tab stops across the two doors do not draw the converged ring.

## Method

Built from this branch (`npm run build`, `out/main/index.js`) and driven through
Playwright `_electron` on an isolated profile (`MULTICODE_USER_DATA_DIR`,
`MULTICODE_ALLOW_MULTI_INSTANCE=1`), with `ELECTRON_RENDERER_URL` /
`NODE_ENV_ELECTRON_VITE` / `NODE_ENV` stripped before launch and `data-mode`
asserted non-null before any number is read. Viewport 1440×900. Workspace under
test: a seeded backlog carrying one purple epic with two members plus a plain
row, so an identity-tinted row and an untinted one are on the same list.

Harness: `scripts/testing/design-system-integration-pass.mjs`, kept alongside
the T15/T18/T19 passes so this is re-runnable rather than a one-off transcript.

**Three traps of this pass's own, each of which produced a false result before
it was caught.** They are recorded because the next pass will hit them too.

1. *The `--border-focus` probe must not be appended to the focused element.* An
   `<input>` is a replaced element; its children never take part in the cascade,
   so a probe span inside one resolves `var(--border-focus)` to the initial
   value — black. Every input then reports "the ring is not the focus colour".
   Read `getComputedStyle(el).getPropertyValue('--border-focus')` off the
   element instead; custom properties inherit, so an ancestor theme override is
   still honoured.
2. *Ring colour must be compared by channel, not by string.* The ring reaches
   the element through Tailwind's `--tw-ring-*` pipeline, which can hand back
   `rgba(r, g, b, a)` where the token is `rgb(r, g, b)`. String equality then
   reports twenty-two painted rings as absent — the first run of this pass
   claimed 26 ringless stops where there are 4.
3. *The ring fades in under `transition-colors`.* Read 90ms after the Tab
   keypress, the ring layer is caught mid-transition at alpha 0.867–0.937, which
   reads as a second, translucent focus treatment that does not exist. Settled
   at 320ms every converged ring is alpha 1.

A fourth, on the selection side: Backlog selection is single-choice, so the
first theme's pass leaves the epic row still selected. Reading the second theme
without handing selection back to another row measures the *selected* fill and
calls it resting, collapsing all three tiers onto one number.

## Criteria

| # | criterion | result |
|---|---|---|
| 1 | `npm run lint` exits 0, every baseline file empty, non-empty baselines recorded as 0 | **met** |
| 2 | `npm run verify:app` and the test suite pass | **met** |
| 3 | both shared-seam files carry every concurrent writer's change intact | **met** |
| 4 | resting / resting-selected / selected are three distinguishable states on an epic-member Backlog row, dark and light | **not met — see I1** |
| 5 | every tab stop on the Backlog and Extensions doors draws the converged ring | **not met — confirms R1** |

### 1 — the guard, at zero tolerance

`npm run lint` exits **0**. The conformance guard reports `tolerance: none — any
violation fails` and 0 found on all fourteen rules, over 595 renderer files plus
`index.css` against `design-system/foundations/tokens.css`. Nine violations are
suppressed by inline `design-system-allow:` markers, each carrying a written
reason, at seven sites.

**Non-empty baseline files: 0.** There are no baseline files at all —
`scripts/design-system-conformance/` is empty and tracks nothing. T15 removed
the general baseline mechanism (`--write-baseline` now exits 2 rather than
writing one); T20 added the single narrow `disabled-contrast.json`, and T21
drained and deleted it. A missing file is zero tolerance by construction, which
the reader documents deliberately: *"A missing file is zero tolerance, which is
what deleting it must mean."*

### 2 — the suite

`npm run verify:app` exits **0**. That is `typecheck` + `lint` + the full main /
preload / renderer / shared / seam suite, including
`test:seams:design-system-conformance`.

### 3 — the two shared seams

Both verified by reading the file at HEAD, not by trusting the commits.

**`scripts/lint-design-system-conformance.mjs`** — T18's `APP_TO_BUNDLE` entry
`'--bg-selected-resting': '--sem-color-bg-selected-resting'` is present at
`:693`. T20's rule is present and, more to the point, **live**: reverting one
theme's `--text-disabled` to its pre-T21 value makes the guard exit **1** with
`theme "slate": --text-disabled (#707070) is 2.81:1 on --bg-surface-raised
(#2c2c30), under the 3:1 floor` — the surface T20 added to the measurement.
Restored, the guard exits 0 and the tree is byte-identical. Neither writer
reformatted or dropped the other.

**`src/renderer/src/assets/index.css`** — T18's 19 `--bg-selected-resting`
declarations are all present (19 at T18's own final commit, 19 at HEAD) and its
`data-selection-pane` rule block is intact. T21's lifted `--text-subtle` /
`--text-disabled` values and T22's opaque `--border-focus`, `--hit-target-min`
and FlexLayout floor are all present. Everything T21 and T22 added after T18 is
purely additive to T18's block; the only edit inside it is T18's own.

### 4 — the T18/T19 seam on one surface

This is the criterion T24 exists for, and it does not hold.

Measured on a seeded epic-member row, selection handed back to a plain row
between themes so each resting read is a genuine resting read:

```
dark    resting          rgb(23, 22, 33)     (the epic tint)
        resting-selected rgb(36, 36, 44)     step from resting 1.162:1
        selected         rgb(36, 36, 44)     step from resting-selected 1.000:1

light   resting          rgb(246, 245, 255)
        resting-selected rgb(216, 220, 224)  step from resting 1.275:1
        selected         rgb(216, 220, 224)  step from resting-selected 1.000:1
```

The resting→selected steps (1.162:1 dark, 1.275:1 light) reproduce T23's F1
numbers exactly, so T19's compositing is confirmed independently and is not in
question. What is in question is the third state: **`resting-selected` and
`selected` are the same fill, to the byte, in both themes.** There are two
states on this surface, not three.

The cause is not a token and not a contrast miss. `--bg-selected-resting`
resolves correctly (`rgb(28, 32, 36)` dark, `rgb(228, 232, 236)` light) and is
distinct from `--bg-selected` in both. It is never applied, because the tier is
opted into with `data-selection-pane` and **the Backlog door's item list is not
one**: the row's nearest `[data-selection-pane]` ancestor is `null`, on a
surface that has two such panes. Per `index.css`, an unmarked list is a
single-pane surface and never rests — so the Backlog list is treated as a
single-pane surface even though it is not one.

Title ink was read in the same three states and is byte-identical across all
three (`rgb(236,236,236)` dark, `rgb(32,36,40)` light), which corroborates T23's
R3 from the fill side: both halves of the tier are missing on this surface, not
just the ink half.

### 5 — the converged ring, door by door

Seventy-four tab stops walked end to end, each walk terminating when focus
cycles back rather than at a fixed step count. Focus read as *computed* style
off `document.activeElement`, with a stop counted as converged only when a
painted box-shadow layer matches the theme's own `--border-focus` by channel.

**Seventy of seventy-four draw the converged ring.** There is exactly one
treatment across both doors — `rgb(63, 148, 104) 0px 0px 0px 2px` and its
`inset` variant, alpha 1, one `--border-focus` (`#3f9468`) everywhere. On the
narrower question the task contract asks — *did any stop lose its ring in the F5
convergence?* — the answer is **no**. Every stop that draws a ring draws the
same one.

Four stops do not draw it:

| door | stop | what it draws instead |
|---|---|---|
| Backlog | `Search every project’s backlog` (input) | nothing — `box-shadow: none`, `outline: none` |
| Backlog | `Open epic Tinted epic` | `outline: auto 1px` — the Chromium UA default |
| Extensions | `Search connectors by name, category, or capability` (input) | nothing — `box-shadow: none`, `outline: none` |
| Extensions | the `Featured` tabpanel (`tabindex=0` scroll container) | `outline: auto 1px` — the Chromium UA default |

The two search inputs are the same component, `InboxSearchInput`, the shared
search chrome on every door rail — which is why the same defect appears once per
door. Both ringless stops and the `Open epic` button are already filed as **R1**
by T23, unchanged and unfixed; this pass confirms R1 on a second surface and
narrows its count from "three stops and the search field" to four named stops
across the two doors walked.

The fourth is new and weaker than the others: the `Featured` tabpanel is a
focusable scroll container rather than a control, so its UA outline is a
different argument from a button's — a keyboard user needs *some* signal that
the scroll region has focus, but it is still the one treatment the design system
cannot theme. Recorded here rather than filed separately; it belongs to R1.

Both counts are floors, not totals. R1's other named sites — the linked-item
button in `BacklogLinksSection` and `BacklogPanel.tsx:2863` — need an item with
links and were not reached by this walk.

## New finding

### I1 — The resting selection tier never reaches the Backlog door (medium)

**Location** — `src/renderer/src/components/workspace/globalSurface/backlog/BacklogGlobalSurface.tsx`
(the `ul[role="listbox"]` that holds the rows); compare
`src/renderer/src/components/workspace/globalSurface/surfaceSubstrate.tsx:353`,
which does carry `data-selection-pane="primary"`.

**What I found** — On an epic-member Backlog row, `resting-selected` and
`selected` paint the identical fill in both `dark` and `light`. The token is
fine and distinct; the list is simply not a `data-selection-pane`, so the CSS
that would drop it to `--bg-selected-resting` never matches. Two panes exist on
that surface and the Backlog list is neither of them.

**Why it matters** — F2 was filed because four panes shouted at once, and T18
built the tier to answer "which of these lists is my keyboard driving?". T23
confirmed the tier works — on the Extensions door and the composer. It does not
work on the Backlog door, which is the surface F1, F3 and F8 were all measured
on and the busiest list in the product. Together with R3 (the ink half, same
surface) the effect is that the Backlog door is the one place the tier was
supposed to help and the one place it is absent.

**Recommended fix** — Put `data-selection-pane` on the Backlog list container,
the same way `surfaceSubstrate` does for the other door rails, and land R3's
conditional on `BacklogRowContent` in the same change so the fill and the ink
rest together. Whether the Backlog list should be `"primary"` or `"auto"` is a
design call, not a mechanical one: `"primary"` keeps the door showing one
focused selection the moment it opens, which is the behaviour every other door
has.

**Owner** — frontend, after an owner ruling on `primary` vs `auto`.

**Verification** — Backlog door at 1440×900, `dark` and `light`, on an
epic-member row: with focus in the list the row paints `--bg-selected`; with
focus moved to another pane it paints `--bg-selected-resting` and its title
drops to `--text-default`; unselected it paints the epic tint. Three distinct
fills, and `scripts/testing/design-system-integration-pass.mjs` exits 0.

## What this pass did not establish

- **Two doors, not every surface.** The ring walk covered the Backlog and
  Extensions doors end to end, as the criterion asks. The Sprints and Reviews
  doors carry the same `InboxSearchInput`, so R1 is on them too by construction,
  but they were not walked.
- **One theme for the ring walk.** Both walks ran in one theme. `--border-focus`
  is opaque in all nineteen after T22 and the guard measures its contrast, so
  the risk of a theme-specific ring failure is low, but it is not measured here.
- **R2 and R3 were not re-measured.** Neither is in this task's criteria; both
  stand where T23 left them.
- **The mutation test covered one rule.** T20's disabled-contrast rule was
  proven live by regressing a value and watching the guard fail. The other
  thirteen rules were confirmed only by their zero counts on a clean tree.
