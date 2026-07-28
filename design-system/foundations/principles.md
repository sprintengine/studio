# Principles

The rules this system enforces that tokens alone cannot. Tokens decide what a
value is; these decide when you are allowed to reach for it.

This file is the authority on how Multicode looks. Where it and your instincts
disagree, it wins. Where it is silent, decide, and add the rule here.

## Restraint

Restraint is the whole craft. The default failure of a generated interface is
not ugliness — it is genericness: many accents, decorative chrome, a
happy-path-only screen. Density is bought by removing elements, words, and
chrome, never by shrinking type or crushing rhythm.

**The accent budget.** Solid, saturated color is the strongest signal the system
has, so it is spent on almost nothing:

- `accent.primary` as a **solid fill** appears on the **primary action** and
  nowhere else. One per view — an inspector aside counts as its own view.
- `accent.primary` as **ink or a hairline** may mark focus (`focus.ring`) and a
  genuinely live process.
- Everything else earns its weight from the neutral ink and surface ramps.

If a surface needs a second accent, it is missing hierarchy, not color. Status
hues (`status.*`) are not accents: never a button background, section border,
chrome tint, or category code.

**Selection is neutral.** A selected row uses `bg.selected` — a neutral fill —
and lifts its title to `text.primary`. It does not use the accent, and it does
not carry a left bar, a border box, or a glow. A row that is merely *chosen*
must never outrank the one action worth taking.

## Quantified restraint

Ceilings, not guidelines. Exceeding one signals missing hierarchy; when a view
exceeds one, model the domain again rather than adding chrome.

| Ceiling | Limit |
|---|---|
| Product accents visible per view | 1 |
| Status idioms | 1 — the 6px dot or a lifecycle glyph, never both |
| Font families | 2 — `font.family.ui`, `font.family.mono` |
| Font weights per view | 3 |
| Font sizes per view | 3, repeating title / body / meta |
| Border radii per view | 2 |
| Controls above the first content row of a panel | 5 |
| Visual elements per repeated row at rest | 4 |
| Trailing actions a row may reveal on hover | 2 |
| Motion treatments animating at any moment | 1 |

## Selection and focus

Selection answers "what did I pick?". Focus answers "where am I typing?". They
are different questions and never share a treatment.

- **Focused selection** — `bg.selected`, title at `text.primary`. The list the
  user is driving right now.
- **Resting selection** — `bg.selected-resting`, title at `text.default`. Every
  other pane's selection: it remembers the choice without competing.
- **A multi-pane surface has exactly one focused selection.** In a
  rail → list → detail layout, two of the three panes are always resting. Three
  panes rendering a full-strength selection at once is the defect this rule
  exists to prevent.
- **Focus** is `focus.ring` on `:focus-visible`, with `outline: none`. Never on
  `:focus` — a mouse click must not draw a ring. Never suppressed.
- **Hover** is a background change to `bg.hover`. No shadow, no scale, no glow,
  no border appearing on hover and shifting the layout.

## Progressive disclosure

What you withhold is as deliberate as what you show. No screen confronts a
person with everything at once.

- Each screen gets one visual priority. High-signal status and the default
  reading path are visible; secondary detail and lower-frequency configuration
  are revealed as the user reaches for them, behind nearby disclosure.
- **Prefer per-row and per-cell actions revealed on hover or focus over
  always-on controls.** Delete, roll back, close, reveal-in-folder, and the rest
  belong to the row you are pointing at — not to every row simultaneously.
- Anything revealed on hover **must also appear on keyboard focus**, and must
  have a non-hover path (an overflow menu, a context menu, or the detail pane).
  Hover-only is a bug, not a style.
- Revealing an action must not resize or reflow the row. Reserve its space, or
  reveal it over the row's trailing padding.
- Disclosure is not concealment: destructive or state-changing actions stay
  discoverable, and a state a person must act on is never hidden behind hover.

## Hairlines carry the structure

- Borders do the structural work. Cards, fills, and shadows do not. Group with
  space and a heading before reaching for a container; a card inside a card
  needs a real containment reason.
- Hairlines are 1px at canonical zoom. No doubled borders where surfaces meet,
  no 2px divider as decoration.
- **Elevation is a three-step ramp, and every step is an overlay:**
  `shadow.popover` for trigger-anchored surfaces, `shadow.drawer` for drawers
  and side panels, `shadow.modal` for centred dialogs. Nothing in the document
  flow — no card, row, or hover state — takes a shadow.
- In light mode, `bg.surface-raised` is deliberately the same white as
  `bg.surface`: raised surfaces separate by shadow and `border.strong`, not by
  tone. In dark mode the tone step does the work.

## Space and size

- Every padding, gap, and margin comes from `sem.space.*` — a 2px grid at the
  dense end opening to 4px steps at panel scale. A raw pixel value in a
  component means the scale is missing a step; add it here rather than locally.
- Controls come from `sem.size.control.*`: `xs` (24px) for icon buttons and
  in-row triggers, `sm` (28px) as the default for anything with a label, `md`
  (32px) for overlay primary actions. An input and a select side by side must
  share a height.
- Nothing interactive is drawn below `sem.size.hit-target-min`. A small glyph
  pads out to it with a transparent hit area rather than shrinking its target.
- At most 2 radii per view. `radius.control` (5px) is the default; larger radii
  belong to overlay and modal shells. Marketing radii (`rounded-2xl` and up)
  never appear on operational chrome.

## Type

**Two families, permanently.** `font.family.ui` (Inter) for everything a person
reads; `font.family.mono` (JetBrains Mono) for identifiers, paths, hashes,
code, and `kbd`. There is no third family, and no serif anywhere in the
product. Introducing one is a system change, not a styling choice.

- Sentence case everywhere except real keyboard shortcuts. No uppercase
  letter-spaced labels as hierarchy — not on section headers, metadata,
  breadcrumbs, or chips.
- The scale repeats title / body / meta. Primary content does not go below
  `font.size.body` (12px).
- Tracking is optical, not decorative: `tracking.tight` on titles at 13px and
  up, `tracking.wide` on mono identifiers and micro labels, `tracking.normal`
  everywhere else.
- Line height by context: `line.tight` for display, `line.default` for UI,
  `line.relaxed` for prose. Not a single default applied everywhere.

**The micro-typography pass** — run before any surface is called done:

- `tabular-nums` on every numeric column: counts, ids, timestamps, durations.
- Mono for identifiers only, never for prose.
- Numbers, ids, and percentages right-align in columns; titles left-align.
  Dense data is never centre-aligned.
- Curly quotes and em-dashes in copy, no double spaces. Code is exempt.

## Status is earned

- Status reads by **shape first, color second** — every state survives
  grayscale. Healthy, done, and idle render no mark at all.
- One status idiom per surface. A 6px dot or a lifecycle glyph — never a dot
  and a tinted pill saying the same thing.
- A status is never text-only with no glyph, nor glyph-only with no accessible
  name.
- The accent green (forest) and the success green (bright emerald) are held
  apart by brightness and saturation. Never retune one toward the other.

## Motion

- One easing curve (`motion.ease.standard`) and three durations. Hover and
  focus at `fast`, popovers at `normal`, drawers at `deliberate`.
- At most one thing animates at a time, and it means one of exactly two things:
  *alive right now* (a streaming or running pulse) or *just changed* (a
  reorder, a just-moved flash). Ambient decoration is not motion, it is noise.
- Motion is never the sole signal of a state change — the accessible name and
  the visible label carry it too.
- Every animation honors `prefers-reduced-motion: reduce`, including the
  `:active` press scale.
- Never put `backdrop-filter` on a full-viewport scrim; separation comes from
  `overlay.scrim` plus the shell's shadow.

## Accessibility

A gate, not a preference. No design system supplies it for you.

- WCAG 2.1 AA, semantic HTML, and full keyboard operation on every surface.
- Body text clears AA on its own surface. `text.subtle` and `text.disabled`
  never carry actionable copy alone. The ink ramp orders identically in both
  modes — `default` darker than `muted` darker than `subtle` darker than
  `disabled` — so a token means the same thing in either theme.
- Visible focus on everything focusable, in a sensible order, never removed.
- Status conveyed by shape or label, never by color alone.
- Real labels on controls; `aria-label` on every icon-only button. Icons that
  duplicate adjacent text are `aria-hidden`.
- Overlays: Escape closes the topmost surface only, focus is restored to the
  trigger, and a modal traps focus while open.
- Design the states, not the happy path. Every data surface distinguishes
  populated, empty, loading, error, unavailable, and permission-denied. A
  failed dependency must never render identically to an empty list.

## Modes

- Light and dark ship from the same semantic tokens. Consumers style with
  `--sem-*` only and never write a per-mode override.
- Dark surfaces are neutral to slightly warm. Blue-shifted darks (`#0a0d18`,
  `#0c1020`) read as generated-dashboard defaults and are out.
- Dark values keep the anti-dither discipline: solid channel values, no pure
  black surfaces.

## Tokens or nothing

- Never hard-code a color, space, size, radius, duration, or z-index the system
  defines. Pick by the token's documented `role` and `use`, not by its looks.
- The `--ref-*` tier is internal plumbing for the token file. Components and
  patterns consume `--sem-*` only.
- Layering comes from `sem.z.*`. A surface that needs to sit between two
  defined layers is the wrong kind of surface.

## Reject on sight

Each of these is a restart signal, not a fix-it-later note. Rebuild the
surface rather than patching it.

- Two or more accent hues competing for primary, or an accent used as a
  selection fill.
- More than two radii or more than three font weights in one view.
- A third font family, or a serif anywhere in the product.
- A badge or tinted pill where a status dot carries the same meaning.
- A card inside a card with no containment reason.
- A hero composition — oversized headline, decorative blob, three-up stat
  row — inside an operational panel.
- A primary button with a gradient fill, inset highlight, or blurred shadow.
- Decorative emoji as iconography, or celebration copy ("✅", "🎉", "Awesome!").
- Placeholder content: "Lorem ipsum", "Card title", "Item 1 / 2 / 3".
- Empty-state copy that explains an obvious interaction ("Click here to
  start"), or marketing copy in operational chrome.
- The same count shown in two places where the values could appear to disagree.
- Always-on row actions that should have been revealed on hover — or
  hover-revealed actions with no keyboard path.
