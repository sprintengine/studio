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
- **Inside an overlay, space separates — rules do not.** A dialog's title, its
  content, and its buttons are divided by padding. A rule under the title and
  another above the buttons cuts a small surface into three boxed strips and
  buys nothing: the shell already draws its own edge, and a shell that scrolls
  as one piece never needed the rules as scroll affordances.
- **One chrome row per content region.** Everything that is chrome for the same
  content shares a band — status on the left, controls on the right. A tools bar
  stacked on a status bar spends a second band of vertical space to say what the
  first could hold. When you reach for a second row, the question is which row
  the new control belongs in, not where to put the new row.
- **A notice carries its tone with a glyph, not a coloured edge.** A 2px stripe
  down one side of an error or warning card is decoration wearing a hairline's
  clothes: it doubles the card's own border, breaks the 1px rule, and leaves the
  tone carried by colour alone. Use a 1px neutral hairline, the soft tone tint,
  and the tone glyph at the leading edge — which is what makes it survive
  greyscale.

## Space and size

- Every padding, gap, and margin comes from `sem.space.*` — a 2px grid at the
  dense end opening to 4px steps at panel scale. A raw pixel value in a
  component means the scale is missing a step; add it here rather than locally.
- Controls come from `sem.size.control.*`: `xs` (26px) for icon buttons and
  in-row triggers, `sm` (30px) as the default for anything with a label, `md`
  (34px) for overlay primary actions. An input and a select side by side must
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
  `font.size.body` (13px).
- Tracking is optical, not decorative: `tracking.tight` on titles at 14px and
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

## Copy

Copy is the last resort, not the first. A sentence in the interface is an
admission that the interface did not carry the meaning on its own.

**The UI does not explain the UI.** If a control needs a sentence beside it to
say why it exists or what will happen, the control is wrong — redesign it. The
generated-interface tell is a screen where every element has a caption. Delete,
in this order:

- A subtitle that restates the title. "Add a skill source" / "A public GitHub
  repository. We walk it and find the skills" says the same thing twice.
- A field label that restates the dialog title. One field under "New horizon"
  does not need a "Horizon name" label above it — pass the name to the control
  as its accessible name and let the placeholder do the visible work.
- Helper text that restates the placeholder. A field showing `owner/repo` does
  not need "a github.com address, or owner/repo" beneath it.
- A closing paragraph reassuring the user about what just happened. "X is now
  one of your sources. Nothing is installed yet — take skills from it when you
  want them" is three sentences replacing a state the screen already shows.

A line of copy earns its place only by carrying something the screen cannot:
a consequence the user cannot see (where a file will be written), or a fact
they cannot infer (which project this adopted as its home).

**The product does not name itself.** UI copy never says the application's
name. "Multicode will run this command", "cannot be undone from Multicode",
"while Multicode is open" — every one of these is the app narrating itself in
the third person, and no serious product does it. Write the sentence without
the name: "Will run:", "cannot be undone from here", "while the app is open".
The name belongs in exactly four places: the window title, the About/version
line, the sign-in and account surfaces, and first-run onboarding.

**Report the result, not the inventory.** When an operation finishes, show the
one fact that answers "did it work?" — a count, a name, a state. Everything
else the operation happens to know (file counts, commit hashes, byte sizes,
which internal layout was chosen) is stored, not displayed. Metadata dumped
into a success message reads as a machine reporting to itself.

**Empty is not invalid.** A required field nobody has filled in yet is not an
error. Do not mark it with a red "Required" or an asterisk on open — the
disabled confirm button already says "not yet". Validation messages appear
after the first keystroke, never before.

## Composition

Tokens govern values and components govern parts. Neither one governs how parts
are assembled into a surface — and that is where generated interfaces actually
fail. A screen can use every correct token, every approved component, and still
be wrong because it has two toolbars, a search detached from the list it
filters, and a heading over a group of one.

So the system fixes canonical **anatomies**. An anatomy is not a suggestion:
where one exists, build to it, and if a surface cannot fit it, the surface is
the thing to reconsider.

**The list surface** — every rail, column, and panel whose job is "find a thing
in a list" is built from exactly these parts, in exactly this order:

1. **The create affordance.** "New …", full width, at the very top. Never below
   the scroll.
2. **The search field, with the filter glyph beside it.** One row. Search is the
   only at-rest narrowing control; every other axis — project, view, sort,
   group — is an option inside the glyph's menu. Because collapsing them hides
   that a filter is applied, the glyph marks itself active whenever any axis is
   off its default.
3. **One divider.** Directly under the search row, and nowhere else in the
   header. This is the line that means "the list starts here" — it is the only
   rule the surface gets.
4. **The rows.**

Two consequences follow, and both were real defects:

- **A second full-width control never stacks above the search.** A project
  Select sitting over the field it narrows is a control competing with the
  control beside it, and it puts the same choice in two different shapes on two
  different surfaces.
- **The search belongs to the column it narrows, not to the screen.** In a
  list-plus-detail layout, a search bar spanning the full width reads as "search
  this screen" while it only ever filters the left column. Constrain it — and
  its divider — to the column it acts on.

**One chrome band per region of content.** Everything that is chrome for the
same content shares a row: status on the left, controls on the right. Reaching
for a second band means asking which band the new control belongs in, not where
to put the new band.

**A heading must separate something from something else.** Do not label an
ungrouped list ("Horizons" over a field that already reads "Search horizons…"),
and do not render a group heading when there is only one group — "Recent"
spanning every row groups nothing. Headings appear when there are at least two
groups to tell apart; the list's accessible name carries the label otherwise.

**A dialog is header, content, actions — separated by space.** No rule under the
title, none above the buttons. See *Hairlines carry the structure*.

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
- A subtitle restating the title, a field label restating the dialog title, or
  helper text restating the placeholder.
- The application naming itself in ordinary UI copy.
- A success message that dumps the operation's metadata instead of its result.
- A red "Required" or an asterisk on a field nobody has filled in yet.
- A tone-coloured bar down the left edge of a notice, card, or callout.
- Two stacked bands of chrome above one region of content.
- Dividers separating the sections of a dialog.
- The same count shown in two places where the values could appear to disagree.
- Always-on row actions that should have been revealed on hover — or
  hover-revealed actions with no keyboard path.
