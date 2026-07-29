# Adversarial review — design-system conformance token layer

Task T14. Under review: T2 (the app consumes the bundle), T3 (ramp + contrast
across every theme), T12 (micro type floor), and T1 (the conformance guard).

Verdict: **changes requested.** Six findings, two of them holes in the guard
that is supposed to hold the token layer. Nothing here blocks the sprint's
end-state values, which are correct; the failures are in what the guard can
still let through and in one contrast floor that was measured against the wrong
surface.

All guard findings are against the **committed** guard at HEAD. A sibling task
is mid-rewrite of `scripts/lint-design-system-conformance.mjs` — the working
copy crashes (`ReferenceError: BASELINES_TO_WRITE is not defined`) — so F1, F2
and F4 must be re-checked against that rewrite before it lands.

## Method

Source-line review is the wrong instrument here: the app and the bundle agreed
value-for-value at plan time, so an accidental value change is invisible in a
diff. Every claim below is measured as a **computed** value in a real CSS
engine (Chromium via Playwright), across all nineteen themes, with each theme's
`data-mode` stamped exactly as `applyThemeAttributes()` writes it.

Three standalone pages were built from `src/renderer/src/assets/index.css` at
three commits — `c606486a` (pre-sprint), `3cfaa11f` (T2 only), HEAD — each with
the bundle inlined in place of its `@import` and the Tailwind/Google-Fonts
imports stripped. Every custom property declared anywhere in the sheet was read
back with `getComputedStyle` per theme and diffed pairwise.

Guard probes ran against an isolated copy of the tree
(`scripts/`, `design-system/foundations/tokens.css`, `index.css`, one dummy
`.tsx`) so no probe ever mutated the shared worktree.

## Findings

### F1 — `app-token-restates-bundle` never checks that an alias points at its own counterpart (high)

The rule exists to police a 51-entry name-for-name mapping. Its first act on a
declaration is:

```js
if (/^var\(--sem-[\w-]+\)$/.test(declaration.value)) continue
```

Any `--sem-*` alias is accepted. The one error class the mapping can actually
have — aliasing the *wrong* bundle token — is invisible.

Probe: `--bg-app: var(--sem-color-bg-selected)` in the base block.

```
guard exit: 0        (no rule fired)
```

The app canvas would render as the selected-row fill in every theme, and the
rule whose whole job is the mapping says nothing. With 51 mappings written by
hand in one commit, this is the defect most likely to be present and least
likely to be caught.

- **Fix** — drop the early-out. An alias is conforming only when it equals
  `APP_TO_BUNDLE.get(name)`; an alias to any other `--sem-*` is a violation with
  its own message ("aliases X, counterpart is Y").
- **Owner** — developer (guard).
- **Verify** — set `--bg-app: var(--sem-color-bg-selected)`; guard must exit 1.

### F2 — only two `:root` blocks are scanned, and a third already exists (high)

`baseBlock` and `lightBlock` are single `.find()` results: the first block whose
selector list carries `dark`, and the one that is exactly `light`. Every other
`:root`-family block in the file is invisible to the rule.

`src/renderer/src/assets/index.css:1448` is already a third bare `:root` block
(the git-lane palette), so this is not hypothetical shape.

Probe — append to the file:

```css
:root {
  --accent-primary: #3f9468;
  --bg-hover: #18181c;
  --border-strong: rgba(252, 252, 252, 0.12);
}
```

```
guard exit: 0        (no rule fired at all)
```

Three bundle values restated verbatim, silently. An earlier variant that also
set `--text-strong` *was* caught — but by `theme-ramp-contrast`, incidentally,
because it happened to invert the light-family ramps. Restatements that leave
the ramp alone pass.

The restatement is not inert. Injecting a later bare `:root` and re-reading
computed values: `--icon-md` took the injected value under `light`, `slate`,
`gruvbox` and `vellum`, and not under `dark` — because only `dark` is matched by
the base block's higher-specificity `:root[data-theme="dark"]` half. So a
literal in an unscanned `:root` block wins the cascade for **18 of the 19
themes**, for any variable that theme does not itself declare.

- **Fix** — scan for mapped names across *every* `:root`-family block. The two
  located blocks are the only ones permitted to alias; a mapped name declared in
  any other `:root` block is a violation regardless of its value.
- **Owner** — developer (guard).
- **Verify** — the appended block above; guard must exit 1.

### F3 — the 3:1 disabled floor is measured against one surface out of three (medium)

`theme-ramp-contrast` checks `--text-disabled` against `--bg-surface` only. All
nineteen themes clear it there (min 3.07:1) — that part of T3 is sound. Against
`--bg-surface-raised`, **fourteen of nineteen themes are under 3:1**:

| theme | on `--bg-surface` | on `--bg-surface-raised` |
|---|---|---|
| gruvbox | 3.10 | **2.44** |
| tokyo-night | 3.09 | **2.67** |
| caramel | 3.08 | **2.77** |
| fernery | 3.11 | **2.78** |
| sage | 3.12 | **2.78** |
| slate | 3.13 | **2.81** |
| lantern | 3.10 | **2.84** |
| verdigris | 3.07 | **2.85** |
| herbarium-dark | 3.15 | **2.86** |
| aubergine | 3.19 | **2.89** |
| rose-pine | 3.12 | **2.93** |
| ayu-mirage | 3.09 | **2.93** |
| greenhouse | 3.15 | **2.98** |
| conifer | 3.13 | **2.99** |

The flagship `light` theme is also **2.95:1** against `--bg-app`.

That surface is real chrome, not a theoretical pairing.
`src/renderer/src/components/ui/CliModelListbox.tsx:119` paints
`bg-[color:var(--bg-surface-raised)]`, and line 133 renders 10px
`text-[color:var(--text-disabled)]` inside it. `CommandPalette.tsx`,
`ConfirmDialog.tsx`, `KbdChord.tsx` and `SkillPickerPopover.tsx` pair the same
two tokens.

This is **not a regression** — T3 improved every one of these substantially
(tokyo-night 1.44 → 2.67, gruvbox 1.42 → 2.44, aubergine 1.47 → 2.89). It
stopped where the guard measures. The result is a guard that certifies a floor
the product does not meet on the surface where disabled ink most often lands.

- **Fix** — extend the rule to `--bg-surface-raised` and `--bg-app`, then lift
  `--text-disabled` in the fourteen themes until all three clear 3:1.
- **Owner** — developer (guard), then frontend (per-theme values).
- **Verify** — guard reports the fourteen themes before the values change and
  exits 0 after.

### F4 — the `shadow-in-flow` fix hint names a token the app does not declare (medium)

```
'shadow-in-flow': 'overlays take --shadow-popover / --shadow-modal; …'
```

`--shadow-popover` is declared nowhere in `src/`. `index.css` aliases
`--shadow-drawer` and `--shadow-modal` only; the bundle's `--sem-shadow-popover`
has no app consumer. A developer clearing a `shadow-in-flow` violation by
following the hint writes `shadow-[var(--shadow-popover)]`, which substitutes to
nothing and silently paints no shadow — the guard goes green on a popover that
lost its elevation.

- **Fix** — alias `--shadow-popover: var(--sem-shadow-popover)` in the base and
  light blocks and add it to `APP_TO_BUNDLE`. (Correcting the hint instead
  leaves the bundle's middle elevation step unreachable.)
- **Owner** — developer.
- **Verify** — `--shadow-popover` resolves to the bundle value under both modes;
  `shadow-[var(--shadow-popover)]` renders a shadow.

### F5 — T2 shipped as "wiring only" but moved two rendered values (low)

Computed-value diff, `c606486a` → `3cfaa11f`, all nineteen themes:

```
dark  --text-disabled : #5c5c64 -> #626269
light --text-subtle   : #5f6772 -> #6e7682
```

(plus one whitespace-only change to `light --shadow-drawer`.)

Those are exactly the two defects the backlog names — landed by the wiring
commit, because aliasing the bundle picks up the bundle's corrected values for
free. The backlog asked for the opposite ordering, explicitly:

> Do this behind a name-for-name mapping so no visual change lands with the
> wiring, then fix the two contrast defects as a separate, reviewable commit.

The end state is correct and no third value moved. The cost is reviewability: a
bisect for a visual regression would skip the wiring commit on a false premise,
and T3's diff no longer shows the two defects it was scoped to fix.

- **Fix** — none to the code. Correct T2's evidence to state that aliasing
  carried the two bundle fixes with it.
- **Owner** — architect (record), developer (evidence).

### F6 — two-thirds of the bundle has no app consumer, and the guard restates it by hand instead (low)

`index.css` aliases 52 bundle tokens. **33 `--sem-*` tokens have no consumer at
all**: the whole of `--sem-space-*`, `--sem-z-*`, `--sem-size-control-*`,
`--sem-focus-ring*`, `--sem-font-family-*`, `--sem-font-weight-*`,
`--sem-font-tracking-*`, plus `--sem-shadow-popover` and
`--sem-color-bg-selected-resting`. Exactly one component reads a `--sem-*`
directly (`DiagnosticsOverlay.tsx:55`).

So the acceptance criterion "changing a value in `tokens.tokens.json` and
rebuilding changes the app" holds for the colour, type, icon, radius and motion
tiers, and is false for the spacing, layering, control-size and focus tiers.

Those tiers are not unowned — the guard owns them, as hardcoded numbers:
`MICRO_FLOOR_PX = 10` beside `--sem-font-size-micro: 10px`,
`MARKETING_RADIUS_FLOOR_PX = 16`, `value % 2 === 0` for the space grid, and the
layering scale spelled out in a fix-hint string. That is a second hand-maintained
copy of bundle values with nothing keeping it in sync — a fresh instance of the
drift this epic exists to end.

Separately, `--shadow-modal` is aliased in `index.css` but absent from
`APP_TO_BUNDLE`, so a literal restatement there is unguarded.

- **Fix** — derive the guard's numeric constants from
  `design-system/foundations/tokens.tokens.json`, and add `--shadow-modal` to
  the mapping. Aliasing the remaining tiers is a follow-up item, not this sprint.
- **Owner** — architect (scope), developer (guard constants).

## Probes that failed to break anything

Recorded because a probe that found nothing is evidence too.

| Probe | Result |
|---|---|
| A variable reading through the bundle in one window and not another | **No divergence.** `src/renderer/index.html` is the only HTML entry; `window-factory.ts` loads it for the main, diagnostics and aux windows alike, and all three mount `useAppTheme()`. `applyThemeAttributes()` writes `data-theme` and `data-mode` in one call, so they cannot separate. |
| A theme whose `data-mode` resolves to the wrong polarity | **None.** The boot script's hardcoded `LIGHT_SURFACES` (`light`, `vellum`, `herbarium`, `paper`) matches the derived `LIGHT_SURFACE_THEMES` exactly. Every theme's swatch luminance is decisive — dark themes 0.033–0.133, light themes 0.841–0.945 — so no theme sits near the 0.5 split where the two could diverge. |
| A hand-edited bundle | **None.** `node design-system/scripts/build-tokens.mjs` reproduces `design-system/foundations/tokens.css` byte-identically (`git diff` empty). |
| A theme T3 left inverted, or under 3:1 on `--bg-surface` | **None.** All nineteen themes order strong → default → muted → subtle → disabled monotonically in their own polarity, and clear 3:1 on `--bg-surface` (min 3.07:1, verdigris). |
| A literal reintroduced via `!important`, a `var()` fallback, or one-hop indirection | **All caught.** `var(--sem-color-bg-app, #08080c)` and `--bg-app: var(--app-canvas-ink)` both report as drift; a plain literal in the base or light block reports as a restatement. |
| Any other rendered value moved by the wiring | **None.** Across all nineteen themes, no `--bg-*`, `--border-*`, `--accent-*`, `--tone-*`, `--icon-*`, `--radius-*` or `--motion-*` value changed. The full sprint (T2+T3+T7+T12) moves 61 values, every one attributable: `--shadow-modal` newly declared (T7), `--text-subtle`/`--text-disabled` (T3), `--text-size-2xs` 10.5px → 10px (T12). |
| A rule firing on a clean line | **None observed.** The guard reports 0 findings across 593 source files plus `index.css`, with 9 violations suppressed by 7 `design-system-allow` markers, each carrying a real reason. |

## Deliberate regressions

Introduced against the committed guard in the isolated harness, then reverted.

```
$ node scripts/lint-design-system-conformance.mjs            # clean tree
exit=0

# swap --text-subtle / --text-disabled in the gruvbox block
$ node scripts/lint-design-system-conformance.mjs
  724:1  theme-ramp-contrast  theme "gruvbox": --text-disabled (#907868) inverts against --text-subtle (#807060)
Unbaselined violations: 1
exit=1

# push slate --text-disabled to #4c4c4c
$ node scripts/lint-design-system-conformance.mjs
  382:1  theme-ramp-contrast  theme "slate": --text-disabled (#4c4c4c) is 1.81:1 on --bg-surface (#242424), under the 3:1 floor
Unbaselined violations: 1
exit=1

# restate the bundle value as a literal in the base dark block
$ node scripts/lint-design-system-conformance.mjs
  52:1  app-token-restates-bundle  dark --bg-app restates --sem-color-bg-app (app #08080c)
exit=1

# a drifted literal in the light block
$ node scripts/lint-design-system-conformance.mjs
  267:1  app-token-restates-bundle  light --bg-surface drifts from --sem-color-bg-surface (app #fafafa, bundle #ffffff)
exit=1

$ node scripts/lint-design-system-conformance.mjs            # after revert
exit=0
```

The guard fires on every violation it claims to own, with an accurate message,
and returns to green on revert. The failures in F1 and F2 are violations it does
not claim — which is the point: the rule's stated scope is narrower than the
invariant it is trusted to hold.

## Residual risk

- **Not checked: the in-flight guard rewrite.** A sibling task is editing
  `scripts/lint-design-system-conformance.mjs` right now and the working copy
  does not run. F1, F2 and F4 are against HEAD and must be re-tested after it
  lands.
- **Not checked: alpha and `color-mix()` values.** The contrast maths only
  evaluate opaque colours, so every `--border-*`, every `--*-soft` tint, and
  every `color-mix()` token (`--tone-error-on-tint`, `--tool-sprintengine-ink`,
  `--git-lane-*`) is unmeasured. The guard shares this limit, and reports rather
  than skips what it cannot resolve.
- **Not checked: painted pixels.** This compares token values, not screenshots.
  A component that hardcodes a colour instead of reading a token is invisible to
  every method used here.
- **Not checked: the twelve component rules.** T13 and T15 own those; this review
  only observed that they report zero findings on the current tree.
- **Assumption.** The pre-sprint comparison point is `c606486a`, the last commit
  touching `index.css` before T2. If any earlier sprint commit changed a token
  through another file, that change is folded into the "before" baseline.
