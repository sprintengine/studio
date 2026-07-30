# Spec review — premium feel pass (epic 1999)

Acceptance conformance across the epic's nine children, the Knowledge Graph,
and the epic's explicit non-adoptions. Reviewed 2026-07-30 (T16) against the
branch `sprintengine/premium-feel-pass`.

Method: each child read in full, every acceptance criterion it states checked
against shipped code, tests run rather than assumed. Verdicts below are per
criterion, not per item.

## Verdict

**Eight of nine children conform. One does not: 1993's first criterion fails.**

| Item | Verdict |
|---|---|
| 1996 type + icon scale | met |
| 1997 switch + motion | met |
| 1994 provider rows | met |
| 1995 version-control sections | met (scoped, see Q1) |
| 1992 model + reasoning pickers | met |
| **1993 context-rail navigation** | **not met — criterion 1** |
| 1991 sidebar brand header | met |
| 1990 open in editor | met (one drift corrected) |
| 1998 design-system integration + sweep | met |

## The one failure

**1993, criterion 1 — "No app state shows two navigation columns left of
content, anywhere."**

Opening the Extensions door and selecting Skills renders two list rails at once:

- `ExtensionsGlobalSurface.tsx:259` builds a `SurfaceRail` and passes it as
  `rail`; `GlobalSurfaceShell` portals it into the app sidebar's own column —
  1993's mechanism, working as specified.
- `SkillsSurface.tsx:257` then mounts a **second** `SurfaceRail` inside a fixed
  `w-[216px]` bordered `<nav aria-label="Skill sources">` in the canvas region.

The door's own code acknowledges it (`ExtensionsGlobalSurface.tsx:329`: "Skills
brings its own nested rail and scrolls beside it"). It predates 1993; moving
door rails into the sidebar column made it visible rather than causing it.

An audit of every `<SurfaceRail` mount confirms this is the only instance —
five of six doors are clean, and every other hit is a `rail` prop, not a canvas
mount.

It is **filed** as `backlog/2026-07-30-skills-nested-rail-in-extensions.md`
with three options and a recommendation, correctly tagged to this epic. Filing
is the right disposition for the work; it does not make the criterion met.

Secondary consequence, worth recording: principles.md ("Selection and focus")
allows one focused selection per surface, and both rails render a full-strength
selection simultaneously — the nested-selection trap the workspace already hit
once.

## Per-child evidence

**1996 — met.** `sem.font.size.*` = 11/12/13/14/16, `sem.icon.size.*` =
13/16/18/22, `sem.size.control.*` = 26/30/34 in `tokens.tokens.json`, matching
the proposed table exactly. `design-system/scripts/lint.mjs` exits 0.
`--control-xs/sm/md` alias `--sem-size-control-*` at `index.css:307-309`; the
`@theme` block is at `index.css:39`. Sidebar, Extensions door, and settings
render zero `text-[Npx]` arbitrary values. No single view renders more than 3
font sizes — `SettingsPanel.tsx` carries 4 across 2994 lines, but `text-micro`
(l.726, l.760) sits in the providers tab and `text-title` (l.1873+) in others,
so no view shows all four.

**1997 — met.** `Switch.tsx:68` is `h-[18px] w-8` with a `h-3 w-3` thumb.
`.interactive` (`index.css:1875`) uses `var(--motion-fast)` /
`var(--motion-ease)`; `.popover-enter` (`index.css:2127`) uses
`var(--motion-normal)` / `var(--motion-ease)` over the existing 4px travel +
fade — neither references a literal duration or curve. Reduced-motion guards
at `index.css:2398-2410` cover the animation, the transition, and the press
scale. `switch` is registered in `design-system.json`. One `Switch` primitive
exists, so "every switch in the product" holds by construction.

**1994 — met.** `ProviderRow` exists as a shared `ui/` primitive; its tests
pass. `stateLine` is mandatory and the dot is `aria-hidden`, so dot colour
never carries state alone. `version` absent renders nothing — no placeholder.
A host with no enablement state renders no switch (seam-proven).

**1995 — met, at the scope D2 set.** The seam drives the real main-process
probe through the real preload passthrough and proves five states render as
distinct rows: resolved git, unauthenticated gh, gh with a login, "not
installed" vs "we could not ask", and a provider the round-trip skipped
reading unknown rather than installed. No row renders for a provider the
product does not integrate.

**1992 — met.** `cli-model-picker` passes 25 assertions; the seam proves both
new popovers open on the keyboard and ride the one shared enter transition.

**1991 — met.** `SprintEngineWordmark` renders in exactly one place
(`SidebarChrome.tsx:126`). `MulticodeWordmark` is deleted — zero references
anywhere in `src/`. The principles.md carve-out is written (l.204-209),
including "exactly once is literal, so a second placement retires the first".

**1990 — met, with a drift correction.** `SplitButton.tsx:153-180` is one
bordered group owning the border, radius, and height, with borderless halves
and one internal `border-l` hairline. `⌘O` is a real binding — command
`workspace.folder.reveal` with `defaultKeybindings: ['Primary+O']`
(`commandRegistry.ts:159`) — not just a menu label. The seam proves probe-hide
rather than probe-disable, and that a remembered target that no longer resolves
falls back rather than arming a failure.

*Drift corrected in place:* the item's criterion read "shared 28px height",
written against the pre-step-up ramp. 1996 stepped `sem.size.control.sm`
28px → 30px and the control uses `h-control-sm`, not a literal. The criterion
now names the token so it tracks the ramp instead of contradicting it.

**1998 — met.** Lint exits 0 at 120 tokens / 19 component+pattern files, with
`switch`, `provider-row`, `split-button`, and `patterns/context-rail.html`
registered. `design-system/sweeps/2026-07-30-app-wide-re-sweep.md` reports
every audited surface as fixed / filed / clean, per door and per directory.
Retired values are grep-verified absent: `h-4 w-7` → 0, arbitrary type in the
10-19px band → 0, hard-coded `font-size` in `index.css` → 0. The renderer went
from ~1,900 arbitrary type sizes to 4, and all four are display-tier values
above the ramp's `title` step (20/22/32px), filed as
`2026-07-30-display-type-tier-above-title.md`.

## Knowledge Graph

All ten notes named in scope were updated on this branch — verified by diff
against `main`, not by presence:

`multicode/design-system-bundle.md`, `multicode/workspace-shell.md`,
`multicode/settings.md`, `multicode/agent-runtime.md`, `brand/design-tokens.md`,
`brand/BRAND-MARK.md`, `brand/workspace-chrome.md`, `brand/panel-patterns.md`,
`brand/primitives.md`, `brand/door-surface-checklist.md`.

Three further notes were also updated (`brand/glyph-system.md`,
`multicode/backlog.md`, `multicode/conversation-agents.md`). No missing note
update found; no blocking KG finding.

## Non-adoptions — all three held

1. **Caption-per-control settings copy** — absent. `ProviderRow` has no
   caption or description slot; `stateLine` is mandatory and documented as
   "not a caption: it says what is true now, not what the provider is for".
2. **Tinted status pills beside dots** — absent. No `StatusPill` or
   `status-pill` construct exists in the renderer.
3. **A second accent** — absent. No `accent-secondary` or `--accent-2` in the
   renderer, the design system, or the token bundle.

## The product name

The standing "app never names itself" ruling is refined, not reversed, and the
refinement holds.

The **wordmark** appears exactly once, as window chrome
(`SidebarChrome.tsx:126`). The name appears in copy in three pre-existing
places, all of which predate this branch and all of which sit inside
principles.md's own long-standing four-place allowance (l.201-202: window
title, About/version line, sign-in and account surfaces, first-run onboarding):

- `OnboardingFlow.tsx:186` — first-run welcome heading.
- `SettingsPanel.tsx:1964` — About/version identity row.
- `WorkspaceManager.tsx:1392` — `document.title`, i.e. the window title.

One further pre-existing occurrence, `TrackerWriteBackSettings.tsx:466`, is a
preview of how a comment this app posts will appear in Jira or Linear — an
author label in external output, not the app narrating itself. Out of this
epic's scope; recorded rather than filed.

## Still-open owner questions

Neither plan question was answered at approval; both shipped on their stated
default, which is the correct conservative outcome. Recording them as still
open rather than closing them:

- **Q1 — 1995 scope.** Shipped git + GitHub only (D2's default), deferring
  GitLab, Bitbucket, and Azure DevOps. If the answer is "build the forges",
  1995 is replanned, not stretched.
- **Q2 — `MulticodeMark` in-app renders.** Treated as out of scope; the mark
  still renders at `SettingsPanel.tsx:1961` and `NewWorkspacePanel.tsx:2586`.
  Confirm, or file a removal item.

## Residual risk

- **Not re-verified here:** 1996's before/after screenshot criterion and
  1997's hover-crossfade spot-check are rendered evidence carried in T1's and
  T2's publishes; this review confirmed the code and token paths behind them,
  not the pixels. Aesthetic judgement was T11/T13's, seam behaviour T15's.
- **Motion tail.** `.settings-overlay-panel` (`index.css:2138-2140`) still
  hard-codes `220ms cubic-bezier(...)`. 1997's acceptance names only
  `.interactive` and `.popover-enter`, both clean, so this is not a miss
  against 1997 — it is inside `2026-07-30-motion-conformance-tail.md`
  (253 hover transitions, 16 animations outside the three eased motions).
- **No guard on the sweep.** `2026-07-30-guard-arbitrary-type-and-icon-sizes.md`
  is filed but unbuilt, so the next `text-[12px]` anyone writes lands green.
  The 1,424 conversions are not defended.
- **Uncommitted in the worktree, outside this task's owned paths:**
  `scripts/lint-design-system-conformance.mjs` carries an uncommitted widening
  of `FOCUS_RING_PRESENT`. The conformance lint reports 0 violations both with
  it and at committed `HEAD`, so no verdict depends on it — but it should land
  or be dropped rather than linger. `provider-rows-dark.png` is an untracked
  screenshot at the repo root, left over from review work.
- **Pre-existing on the epic file:** `backlog/epics/premium-feel-pass.md`
  carries `status: ready` in its frontmatter. An epic's status is derived from
  its children and should not be stored. This task wrote no status onto it and
  left the pre-existing field untouched.

## Child statuses

Eight children stamped `status: completed`: 1996, 1997, 1994, 1995, 1992,
1991, 1990, 1998.

**1993 is not stamped.** Stamping an item complete while its first acceptance
criterion demonstrably fails is exactly the reinterpretation this review is
meant to prevent. Whether 1993 closes with the nested rail deferred to its
filed follow-up is a scope decision, and it is escalated rather than assumed.
