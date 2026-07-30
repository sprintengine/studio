# App-wide re-sweep against the stepped-up design system

Backlog item 1998, epic `premium-feel-pass`, task T14. Swept 2026-07-30 against
the design system as the eight sibling members left it.

**38 surface directories audited** — every directory under `src/renderer/src`
holding at least one `.tsx`, plus `src/renderer/src/assets/index.css`. No
directory was sampled: the audit greps the whole tree, so "clean" below means
measured clean, not unvisited.

Verdicts: **31 fixed**, **3 clean on arrival**, **4 carrying a filed residual**
(3 of those also fixed elsewhere in the same directory).

## What the sweep changed

**1,424 of 1,425 hard-coded type sizes converted** to the `@theme` ramp
utilities T1 registered. Ramp-utility consumption across the renderer went from
522 uses to 1,949. The measured pre-epic baseline was ~1,900 arbitrary sizes
against exactly one token consumer; T1 converted the sidebar, Extensions door
and settings, and this sweep took the remaining tail.

| From | To | Count |
|---|---|---|
| `text-[11px]` | `text-micro` | 568 |
| `text-[12px]` | `text-meta` | 566 |
| `text-[13px]` | `text-body` | 153 |
| `text-[11.5px]` | `text-meta` | 52 |
| `text-[12.5px]` | `text-body` | 32 |
| `text-[15px]` | `text-title` (25) / `text-heading` (1) | 26 |
| `text-[14px]` | `text-heading` | 11 |
| `text-[18px]` | `text-title` | 10 |
| `text-[17px]` | `text-title` | 5 |
| `text-[16px]` | `text-title` | 2 |

Off-ramp values collapsed onto the nearest ramp step rather than earning tokens
of their own, per the item's instruction. 11.5 and 12.5 are exact ties and
resolved **upward**, which is the direction this epic is arguing for. 15px was
also a tie and resolved **upward to `text-title` at 25 of its 26 sites**, all of
them semibold section, dialog or panel headings.

The 26th is the exception worth naming: `utils/markdown.tsx:47`,
the prose base for document-scale markdown, resolved **downward** to
`text-heading`. Upward would have put document body text at the same size as the
titles above it and spent a third font size against the "3 per view" ceiling.
It also fixed a live defect — compact-scale `h1` was 15px over a 15px body, so
the heading outranked its own prose by nothing at all; it is now 16 over 14.

**Icon glyphs onto the icon ramp** — 23 sites: `h-[18px] w-[18px]` → `size-icon-md`
(12), `h-[16px] w-[16px]` → `size-icon-sm` (2), five 15px glyphs in `AgentPanel`
→ `size-icon-sm`, one 17px → `size-icon-md` and one 14px → `size-icon-xs` in
`WorkspaceActions`, and two 11px glyphs (`SprintsRepoStrip`, `AgentPanel`) up to
`size-icon-xs`. Only glyphs were converted. Square **containers** at the same
pixel values were deliberately left — see the filed box-ramp item. Two 30px
empty-state `ChatGlyph`s in `AgentChatView` also remain: they sit 8px above the
ramp's top step and are illustration rather than chrome, so they are filed with
the box gap rather than crushed to `size-icon-lg`.

**Control heights onto the control ramp** — `SegmentedControl` `md` and the
`RosterMenu` trigger, both `h-[30px]` → `h-control-sm` on the exact ramp value.

**Motion and type in the stylesheet** — the two per-component `transition`
declarations that restated `--motion-fast` with a raw `ease` curve
(`.flexlayout__tab_button`, `.flexlayout__splitter`) now consume
`var(--motion-fast) var(--motion-ease)`. The three hard-coded `font-size: 12px`
values in `index.css` now consume `var(--text-size-xs)`. `index.css` has **zero**
hard-coded `font-size` values remaining.

## Retired values — grep-verified absent

| Retired | Grep | Result |
|---|---|---|
| Old switch geometry | `h-4 w-7` / `w-7 h-4` | 0 |
| Arbitrary type in the 10-19px band | `text-\[1[0-9]` | 0 |
| Hard-coded `font-size` in `index.css` | `font-size: *[0-9.]+px` | 0 |
| `.interactive`-covered transition one-offs | `transition: *[a-z-]* *120ms` | 0 |

## Nested rails — checked per door

1993 moved every door rail into the sidebar column, so a door that also mounts a
rail in its canvas now shows two. Checked by cross-referencing every
`<SurfaceRail` mount against every `rail={...}` prop passer.

| Door | Rail mount | Verdict |
|---|---|---|
| Roadmap | `roadmapBoard/RoadmapRail.tsx` → `rail` | clean |
| Sprints | `sprints/SprintsRail.tsx` → `rail` | clean |
| Backlog | `backlog/BacklogGlobalSurface.tsx` (`SurfaceRailHeader`) → `rail` | clean |
| Automations | `automations/AutomationsRail.tsx` → `rail` | clean |
| Reviews | `reviews/ReviewsRail.tsx` → `rail` | clean |
| Extensions | `ExtensionsGlobalSurface.tsx` → `rail`, **plus** `skills/SkillsSurface.tsx:252` in the canvas | **filed** |

Five of six clean. Extensions is the one defect and it is structural — see the
filed item. `panels/review/StepRail.tsx` also takes a prop named `rail`, but it
is a step list rather than a `SurfaceRail`, so it is not a second rail.

## Per-surface verdicts

`fixed` = the sweep converted something here. `clean` = measured already
conformant, nothing to do. `filed` = a residual remains and is covered by a
backlog item below.

| Surface | Files | Changed | Verdict |
|---|---|---|---|
| `components` | 4 | 0 | clean |
| `components/automations` | 4 | 1 | fixed |
| `components/auxWindows` | 3 | 3 | fixed |
| `components/backdrops` | 1 | 0 | clean |
| `components/backlog` | 14 | 9 | fixed |
| `components/brand` | 3 | 0 | clean |
| `components/diagnostics` | 4 | 2 | fixed |
| `components/learn` | 2 | 2 | fixed |
| `components/memory` | 3 | 2 | fixed |
| `components/onboarding` | 8 | 5 | fixed |
| `components/panels` | 27 | 23 | fixed + filed (2 × 20px metrics) |
| `components/panels/AutomationsPanel` | 8 | 4 | fixed |
| `components/panels/ConnectorsPanel` | 6 | 0 | clean (T1) |
| `components/panels/WatchtowerPanel` | 7 | 6 | fixed |
| `components/panels/review` | 20 | 14 | fixed |
| `components/panels/roadmapBoard` | 7 | 5 | fixed |
| `components/panels/sprintEngineBoard` | 7 | 4 | fixed |
| `components/settings` | 20 | 0 | clean (T1) + filed (32px pairing code) |
| `components/terminal` | 2 | 0 | clean |
| `components/ui` | 57 | 27 | fixed |
| `components/workspace` | 33 | 10 | fixed |
| `components/workspace/agentComposer` | 6 | 4 | fixed |
| `components/workspace/globalSurface` | 7 | 3 | fixed |
| `components/workspace/globalSurface/automations` | 5 | 2 | fixed |
| `components/workspace/globalSurface/backlog` | 2 | 1 | fixed |
| `components/workspace/globalSurface/extensions` | 2 | 0 | clean (T1) + filed (nested rail) |
| `components/workspace/globalSurface/extensions/skills` | 9 | 0 | clean (T1) + filed (nested rail) |
| `components/workspace/globalSurface/reviews` | 9 | 5 | fixed |
| `components/workspace/globalSurface/sprints` | 8 | 4 | fixed |
| `components/workspace/guidedBrief` | 11 | 10 | fixed + filed (22px headline) |
| `components/workspace/guidedBrief/CanvasStudio` | 4 | 3 | fixed |
| `components/workspace/guidedBrief/annotate` | 2 | 2 | fixed |
| `components/workspace/newWorkspace` | 15 | 11 | fixed |
| `components/workspace/skills` | 4 | 2 | fixed |
| `components/workspace/topbar` | 1 | 1 | fixed |
| `components/worktree` | 1 | 1 | fixed |
| `utils` | 2 | 1 | fixed |
| `assets/index.css` | 1 | 1 | fixed |

## Filed rather than fixed

Five structural findings became backlog items carrying `epic: premium-feel-pass`
rather than unfinished work inside this task. All five are `status: idea`, not
`ready` — each changes UI or a gate, and the owner rule of 2026-07-26 says a UI
item is not ready without a build-to-it mockup.

- `backlog/2026-07-30-display-type-tier-above-title.md` — the ramp tops out at
  `title` (16px) and 4 sites sit at 20/22/32px. Collapsing a pairing code from
  32px to 16px is a regression, not a conformance fix, and the item was
  instructed not to add tokens for off-ramp values. Needs an owner ruling.
- `backlog/2026-07-30-skills-nested-rail-in-extensions.md` — the one nested rail.
- `backlog/2026-07-30-motion-conformance-tail.md` — 253 `transition-colors`,
  38 `transition-opacity`, 25 `transition-transform` and 16 hard-coded animation
  durations. `.interactive` adds a press response and animates six properties,
  so converting these is a per-site design judgement on 316 call sites, not a
  grep.
- `backlog/2026-07-30-small-box-ramp-gap.md` — 12 bordered micro-containers
  between `icon.lg` (22px) and `control.xs` (26px) with no step to land on.
  Two of them are interactive and below the minimum hit target, which is an
  accessibility question rather than tidiness.
- `backlog/2026-07-30-guard-arbitrary-type-and-icon-sizes.md` — **the one that
  decides whether this sweep lasts.** Nothing currently fails a reintroduced
  `text-[12px]`: `lint-design-system-conformance.mjs` holds the `TEXT_SIZE`
  regex but feeds it only to `micro-type-floor`, which fails sizes *below* 10px,
  which is why it ran green over all 1,425 arbitrary values for as long as they
  existed. That is proof by construction, not a prediction. The guard file is
  outside this task's owned paths and had a live writer in the same run, so the
  rule was filed rather than taken.

## Design-system contributions verified

Verified as landed by the sibling tasks rather than re-done here:

- `design-system.json` `contents` registers `provider-row`, `split-button` and
  `switch` under components, and `patterns/context-rail.html` under patterns.
  Each component carries the full three-file template with all six USAGE.md
  headings.
- `foundations/tokens.css` and `catalog/index.html` reproduce byte-identically
  from `scripts/build-tokens.mjs` and `scripts/build-catalog.mjs` — re-run
  against a clean tree with no resulting diff, so neither is hand-edited.
- `principles.md` carries the brand-wordmark carve-out (T8), the
  `tracking.tight` re-anchor at 14px (T1), and T18's focus line naming the
  offset outline as the product's only focus indicator.

Added by this task: the fourth `principles.md` edit, a **Motion** line naming
the switch thumb, the shared hover/press response and the popover entrance as
the complete set of eased motions, with a per-component `transition` restating a
token duration called out as the tell that a fourth crept in.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | bundles cleanly, then **fails** `check-bundle-budget.mjs` — pre-existing |
| `npm run lint` | 0 violations, including the design-system conformance guard over 611 files |
| `node design-system/scripts/lint.mjs` | 0 violations, 120 tokens, 19 files |
| Renderer test suite | 213 / 219 pass; 5 fail, **all 5 also fail at clean HEAD** |
| `ui-accessibility-contracts` | pass — run explicitly per the architect's C2 note about its three writers |
| Design-system bundle tests | 6 / 6 pass (schema, lint, build-tokens, build-catalog, release, conformance seam) |

The 5 renderer failures are `diagnostics-report`, `sprints-surface-composition`,
`sprintengine-handoff`, `xterm-output-queue` and
`workspace-storage-live-sync-flag`. They were not taken on trust: a detached
worktree was checked out at `6445fafb` with `node_modules` symlinked, and all
five failed there identically, so they pre-date this sweep. Four of the five
also test modules this sweep never touched (`utils/diagnostics/formatDiagnosticsReport.ts`,
`utils/sprintengineHandoff.ts`, `utils/xtermOutputQueue.ts`,
`store/workspaceStore.ts`); the fifth dies on `Killed: 9`, an out-of-memory in
the test bundle rather than an assertion. **This sweep did not fix them and they
remain failing** — they are a pre-existing gate problem outside this epic's
scope, not swept-in damage and not something to adopt as sweep scope.

## Where this falls short of the task's acceptance

Two acceptance criteria are not fully met, and neither is hidden behind a
"filed" verdict without saying so here.

**"No surface mounts a nested rail."** One does — Skills inside Extensions. The
second half of that criterion, "the sweep records that check per door", is met
in full above. The fix is not a small one: skill sources are a real second
navigation axis, and removing the inner rail means choosing between folding
sources into the context rail as a drill-in group, demoting them to a bar
filter, or promoting Skills to its own door. That is a product decision with
three live candidates, which is exactly what this task was told to file rather
than stretch to cover. It is filed with a recommendation, not left implicit.

**"The existing renderer test suite passes."** 213 of 219 pass. The other 5 fail
identically at clean HEAD, verified in a detached worktree rather than assumed,
and 4 of them test modules this sweep never touched. So the sweep introduces no
regression — but the suite does not pass today, and that sentence should not be
reported as satisfied.

**"The app builds."** `electron-vite build` succeeds; the `npm run build` script
then runs `scripts/check-bundle-budget.mjs`, which fails because the eager chunk
is 2075 KB against a 2048 KB ceiling. This is pre-existing and this sweep moves
it the right way: the conversion is a near 1:1 line replacement (1,457
insertions / 1,451 deletions) in which every replacement is *shorter* than what
it replaced — `text-[12px]` → `text-meta` — and the renderer source is 2,058
bytes smaller at this commit than at `6445fafb`. A change that only shortens
string literals cannot push a bundle over a ceiling it was already over.

Worth recording because it nearly went unnoticed: piping a build or a test loop
into `tail` makes the shell report `tail`'s exit code, so both read as passing.
The budget has been failing the whole time. Check exit codes before the pipe.

## Honest limits

- The sweep converted values onto ramps. It did not re-litigate whether each
  surface picked the *right* step — `text-[12px]` became `text-meta` because
  that is what 12px is, not because the sweep judged that element to be meta.
  A surface that was wrong before is now wrong in tokens.
- Boxed row lists that should be spaced `ProviderRow`s were listed as an
  expected finding class. The sweep found no new instances beyond the surfaces
  1994 and 1995 already converted, but this was checked by reading rail and
  settings surfaces rather than by a grep, so it is the least mechanically
  verified line in this report.
- 4 arbitrary type sizes remain, all in the filed display-tier item. The
  `text-\[1[0-9]` grep the acceptance names returns 0; these sit above that band.
