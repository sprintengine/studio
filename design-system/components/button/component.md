# Button

Extracted from the source product's `PrimaryButton`, `GhostButton`, and
`IconButton` primitives. One accent rule applies: a view has at most one
primary button, and it shares its hue with selection chrome.

## Anatomy

- A single `<button>` element with the base class `ds-button` plus one
  variant modifier.
- Optional leading icon sized by `sem.icon.size.sm`, gap 6px.
- Label set in `font.size.body` at `font.weight.medium`, sentence case.

## Variants

- `ds-button--primary` — accent fill (`accent.primary`), `text.on-accent`
  label, and the one faint lit top edge of `shadow.control-raised`. The single
  primary action of a view, and the only control that catches the light.
- `ds-button--ghost` — transparent, `text.muted` label; hover lifts to
  `bg.hover` + `text.primary`. Secondary and tertiary actions.
- `ds-button--icon` — a `size.control.xs` square padded out to
  `size.hit-target-min`, borderless, icon-only. Must carry an `aria-label`.
  The canonical close affordance uses the `close` glyph.
- `ds-button--outline` — a standalone neutral secondary: a `border.strong`
  hairline on a transparent ground, `text.default` label, and no depth at all
  (owner ruling 2026-10-04). Outlined rather than a third *filled* variant, so
  the one-accent rule still holds. Use it where a ghost reads too weak to be
  found but the action is not the view's primary — and only where it stands on
  its own: inside a toolbar or a panel header the same action is a ghost.
- `ds-button--round` — the primary at `radius.pill`, and only for the
  composer's send (owner ruling 2026-10-04; see "The round send" below). With
  `ds-button--icon-only` it is a `size.control.sm` disc; with a word it is a
  capsule of the same height. Its hover, press, focus ring and disabled step
  are the primary's own.
- Sizes: `ds-button--xs` at `size.control.xs` with a `font.size.meta` label
  (dense chrome — toolbars, row actions), default sm at `size.control.sm`, and
  `ds-button--md` at `size.control.md`. The icon-only species has one step
  more, `size.control.lg`, for the app rail's foot alone (the account badge
  and the Settings gear, 2026-09-07) — a labelled button never takes it.

Label padding tracks the size rather than being constant: 8px at xs and sm,
12px at md. A single 12px inset makes a dense `xs` control read as mostly
padding.

### The inline size (2026-09-08)

`ds-button--inline` is the one step that spends **no height**. It is not an
unstyled escape hatch and it is not "bare": it carries the ink, the hover, the
press and the focus ring exactly as the ramp steps do, and gives up only the
control height — because the control sits **inside** a line of running text or a
16–20px metadata line, where a 26px box would set that line's height instead of
riding it. A task id in a dot-separated sentence, a "More" disclosure under a
clamped description, an epic pill on a card's meta row.

It takes `radius.chip` rather than `radius.control`: at a line box's height the
7px control radius eats the corners of a two-word label.

**The hit-target floor does not apply**, and that is the one place this entry
departs from *Space and size*. A control set in running text is a link — its
target is the text — and growing its box to `size.hit-target-min` would push the
lines around it apart. The floor governs a **standalone glyph**, which has no
line to belong to, and the icon steps below honour it exactly.

Where the action needs no box at all — a word in a sentence, with no ground on
hover — the shape is [link-button](../link-button/component.md), not this.

### Alignment

`ds-button--start` / `ds-button--end` move the label off centre, with the
matching text alignment. On the shipped primitive this is a **prop**, not a class
the caller adds: a centred `justify-content` written into the base and a caller's
right-aligned one are two declarations of one property at equal specificity, so a
shortcut recorder whose chord had to sit under a settings column got whichever
the build happened to emit last.

### Media

`ds-button--media` is the one button whose **surface is content**: a pasted
screenshot's thumbnail, a preview frame that opens the thing it shows. It paints
no ink and no ground — the image fills it — so every tone would be a colour on a
picture and every size step a height the aspect frame has already decided. What
it keeps is the `border.subtle` hairline lifting to `border.strong`, the clipped
overflow so the image takes the control's radius, the press scale and the ring.
The caller owns the frame, because a media frame is a content measure rather than
a control height.

### Icon steps below the ramp (2026-09-08)

`sm` / `md` / `lg` are the control ramp — 26 / 30 / 40px. The four steps below
are **not ramp steps**, and they are not a licence to shrink a toolbar. Each is a
glyph inside something whose height is already decided, where a 26px square would
set that container's height instead of riding it.

| Step | Box | Where |
|---|---|---|
| `--icon-xs` | 24px = `size.hit-target-min` | the floor exactly — a canvas header or browser-toolbar glyph, and the first step to reach for |
| `--icon-2xs` | 22px = `icon.size.lg` | inside a tab strip |
| `--icon-3xs` | 16px = `icon.size.sm` | inside a chip or a heading; pair with an ink-only tone, since a 16px fill is a speck |
| `inline` | the glyph plus a 2px inset | a glyph in a title row, where even 16px would be a decision the row has not made |

**Everything under 24px pads out to `size.hit-target-min` with a transparent
overlay** rather than shrinking its target. Not padding: padding would grow the
*drawn* box, and the drawn box is what these steps exist to keep small. The
target does not shrink; only the paint does.

They take `radius.chip` rather than `radius.control`, because 7px on a 16px
square is most of the square.

### The hairline badge

`ds-button--circle` turns the square into a `radius.pill` ring in
`border.default`, lifting to `border.strong`, with **no ground at any state**. It
is the shape a count or a "?" takes beside a heading, where a filled square would
read as a control the heading does not have.

### The round send (owner ruling 2026-10-04)

`ds-button--round` takes the primary to `radius.pill`. It is the composer's
send and nothing else: a small accent disc at `size.control.sm` with an up
arrow, replacing the square `⏎` key the New chat composer used to carry, and a
capsule of the same height when the action is a word ("Schedule", "Save").
Its fill, highlight and press are the primary's own; only the corner moves.
The shipped primitive is `SendButton` beside `PrimaryButton` in `ui/Buttons`,
which swaps the size step's radius out rather than adding a second
`rounded-*` utility. It is a primitive of its own rather than a prop on the
primary, because the primary's props are the module SDK's contract.

Every other button keeps `radius.control`: a pill-shaped button anywhere else
wears the badge shape, which is why `radius.pill` names this as its one
button exception.

### The copy glyph

`CopyGlyphButton` is the icon step with one behaviour built in, and it is the
only copy affordance: a code block's header, a message's action row, a table's
footer and an error box all take it, and none of them spells the word "Copy". A
word costs a label's width in chrome that repeats down a whole transcript, and
it reads as a second action beside the content rather than a property of it.

- **Idle** — the `copy` glyph on an icon step: `--icon-xs` (24px, with a 13px
  glyph) in a dense header, the default `sm` (26px, 16px glyph) in a toolbar.
  Neutral ink, the family's hover.
- **Confirmed** — on a copy that *landed*, the glyph swaps to `check` in
  `status.good` ink and holds for **1200ms**, then swaps back. No transition: it
  is a state flip, and the hold is a timer rather than motion, so it takes no
  duration token. A click while confirmed does nothing — the clipboard already
  holds it, and re-arming would hold the check for as long as someone clicks.
- **Failed** — never the check. The failure goes to the shared toast ("Could not
  copy to clipboard"), because a copy that did not land must not look like one
  that did. Success does **not** toast: the swap already happened under the
  pointer, and a corner toast would be the same news twice, far from the eye.

Accessibility: the accessible name is the label ("Copy code") and it never
changes — renaming a focused button to "Copied" reads as a different control.
The confirmation is announced instead, through a visually hidden, always-present
polite live region whose text becomes "Copied". The tooltip carries the same
label, as on every icon-only control.

The whole control carries `data-copy-exclude`. It sits inside rendered
conversation content, and the selection serialiser drops any subtree so marked,
so a selection dragged across a code block copies the code and not its chrome.
Its click does not bubble: a copy glyph lives in rows and cards that toggle on
click, and copying something must not also collapse it.

With an `html` flavour it writes `text/html` beside `text/plain`, and falls back
to the plain text alone where the rich write is refused.

### Window caption buttons

`ds-caption-button` — the window's own minimise, maximise/restore and close, on
the platforms where the frame is ours to draw. It is a **species**, not a size,
because every one of its departures is the operating system's rather than the
system's, and each would be a defect anywhere else in the product:

- **No height and no radius.** It stretches to the title strip and fills its
  corner square. A rounded caption button floating inside the strip is not what
  any desktop draws.
- **`size.control.lg` wide and no more.** The caption cluster's width is the
  platform's; it is the one place a control's width is not a content measure.
- **A fill on plain `:focus`,** because that is where the OS-standard keyboard
  highlight shows. The **ring** is still the product's one focus indicator and is
  still `:focus-visible`; this is a second, weaker ground underneath it.
- **The ring is drawn inward.** An outset ring at the window's corner is clipped
  by the frame.
- **Close paints the platform's own hover red.** A brand colour of the operating
  system's in exactly the sense a vendor mark is (*Identity colour*): tokenising
  it would replace a colour every other window on the machine agrees on with one
  of ours. It carries its lint marker on the line.

## Ink tones (2026-09-08)

The filled and outlined variants take a two-valued emphasis axis — neutral or
destructive, and there is no third emphasis. A **borderless** control has no fill
to carry emphasis, so what varies is where on the ink ramp it rests and whether
it takes a ground at all, and the product uses six pairs:

| Tone | Rest | Hover | Ground |
|---|---|---|---|
| `neutral` | `text.muted` | `text.primary` | `bg.hover` |
| `danger` | `status.danger` | unchanged | `status.danger-soft` |
| `quiet` | `text.disabled` | `text.default` | `bg.hover` |
| `subtle` | `text.subtle` | `text.default` | `bg.hover` |
| `strong` | `text.primary` | unchanged | `bg.hover` |
| `accent` | `accent.primary` | `accent.hover` | **none** |
| `ink` | `text.subtle` | `text.default` | **none** |

Three rules govern the set:

- **`quiet` is icon-only.** `text.disabled` is certified for 3:1 non-text
  contrast, so it may mark a glyph that is nearly invisible until its row is
  hovered, and it may never carry a label.
- **`strong` holds its ink flat and moves only the ground.** It is for a control
  whose *open* state is already the loud one: hovering an open panel's toggle
  must not read as dimming it.
- **`accent` and `ink` take no ground at any state.** They live inside something
  that already has one — a sentence, a chip, a heading — where a second ground
  would draw a box inside a box. Accent as **ink** is inside the budget; accent
  as a fill is not.

Tone is a **prop on the component**, never a `className`. Two
`color`-setting utilities of equal specificity are resolved by stylesheet order,
and a tone's own `hover` step outranks a caller's resting one outright — so an
override does not merely risk losing, it loses under the pointer specifically.

## Control tiers (owner ruling 2026-10-04)

Every control in the system sits on one of three tiers, and the tier decides its
depth. This entry owns the rule for the whole family; the chip, card, split,
segmented and trigger entries each say which tier their variants take.

| Tier | Where | Treatment |
|---|---|---|
| 1 | The view's primary action — `--primary`, and the destructive fill that stands in for it | The filled ground and **one faint lit top edge**, `shadow.control-raised` (a 1px inset highlight, 12% white in dark, 16% in light). No drop, no sheen |
| 2 | A standalone secondary — `--outline`, a [split button](../split-button/component.md), a [card button](../card-button/component.md)'s launcher tile, a [trigger](../trigger-button/component.md) in a form | Flat on a hairline: `border.strong` on a transparent ground for the buttons; the field and tile grounds they already had. No highlight, no sheen, no drop |
| 3 | A control inside a surface — a toolbar, a panel header, a composer's control row | Ghost: no edge and no ground at rest, `bg.hover` under the pointer. `--ghost` and `--icon`, the [chip button](../chip-button/component.md)'s toolbar variant, and a trigger's `--ghost` |

**Every tier presses the same way:** `scale(0.97)` on the shared hover and press
motion (`motion.duration.fast`, `motion.ease.standard`), and no movement at all
under `prefers-reduced-motion: reduce`. There is no inset "pressed" shadow and
no sheen to drop. A thrown toggle is a selection, and says so with the
`bg.selected` fill under States, not with depth.

Depth is spent once per view, on the action that view exists to take. A
secondary that also caught the light, or a toolbar of lifted chips, would
spend it again on chrome, and once every control carries it, it stops telling
the controls apart.

### The lit lip, strengthened (owner ruling 2026-10-01) — superseded

`control-edge` gained a 1px inset top highlight in both modes, a shallow drop in
light and a sheen; `control-raised` gained a second, softer drop; and the
treatment reached every bordered neutral control that is pressed to act — the
outline button, the toolbar chip, the launcher tile and the segmented thumb —
each sinking on `shadow.control-pressed` while held. The 2026-10-04 ruling
above replaced it: across that many members the depth stopped marking the
pressable control and became texture. `shadow.control-edge`,
`shadow.control-pressed`, `shadow.control-track`, `gradient.control-sheen` and
`gradient.control-raised-sheen` are retired, and a control wearing any of them
again is a regression.

## States

- Hover: primary deepens/brightens to `accent.hover`; outline, ghost and icon
  gain `bg.hover` and stronger ink. The outline's `border.strong` hairline
  holds. Depth never changes on hover — a button that rises under the pointer
  is a hover affordance, not a press one.
- Active: every variant presses by `scale(0.97)`, removed under reduced motion.
  The outline also steps its ground to `bg.active`. The primary keeps its faint
  edge through the press.
- Focus-visible: 2px ring of `border.focus`; never remove the ring without
  replacing it.
- Disabled: 45% opacity, `not-allowed` cursor, hover suppressed, and the
  primary's highlight dropped to `none` — a control that cannot be pressed does
  not catch the light.
- Pressed (icon only): a toggle that stays thrown — a locked terminal, a
  revealed pane — fills `bg.selected` with `text.primary` ink and keeps it
  through hover. It is a **prop on the component**, not a class the caller
  adds: two equal-specificity `text-*` utilities are resolved by stylesheet
  order rather than by the order they appear in the attribute, so a call site
  that paints its own pressed fill loses it to the primitive's `hover:` step.
  The button supplies `aria-pressed` unless the caller sets it, and the prop
  is **tri-state**: leave it undefined on a button that is not a toggle (no
  attribute — a close or delete glyph is an action, not an unpressed toggle),
  pass `false` on a toggle that is currently off (`aria-pressed="false"`, which
  is what a screen reader is owed), `true` when thrown. Defaulting the prop to
  `false` collapses the first two cases and silently downgrades every toggle to
  a plain button. Never the accent — a thrown toggle is a selection, and
  selection is neutral.

### Armed (2026-09-08)

A control that is not merely thrown but **listening**: the shortcut recorder
while it captures a chord, and nothing else so far. It is the one borderless
state that takes the accent, and it takes it as `accent.primary-soft` — a tint,
not the solid fill the view's primary action owns — because *recording right now*
is the live-process case the accent budget explicitly reserves ink and hairlines
for.

It is a **moment, not a standing choice**. A control that stayed armed would be
spending the accent on a selection, which is what the neutral pressed fill is
for. `armed` outranks `pressed`: a control cannot be both listening and merely
chosen.

### Busy, and unavailable

Two states that both look "off" and mean different things, and neither is
`disabled`:

- **Busy** — disabled *because the control is working*. An "Open in browser"
  that has been pressed, a save mid-flight. It announces `aria-busy` and swaps
  the cursor to `wait`, which says *wait* where `not-allowed` says *no*.
- **Unavailable** — `aria-disabled` rather than `disabled`, so the control keeps
  its tab stop. `disabled` takes it out of the tab order, which leaves the
  tooltip explaining *why* it is off reachable with a pointer only. The look is
  identical; the press scale is suppressed either way.

## Usage

- One primary button per view; everything else is ghost or icon.
- **A confirm/cancel pair is one rung apart, never the same rung twice.** Where
  the view's one primary is spent elsewhere, the affirmative takes `outline`
  and its counterpart drops to `ghost`. Two neutral outlines side by side —
  which is what an audit sweep produced for Approve/Deny in the agent chat —
  leave the two actions distinguishable only by reading the labels.
- Destructive confirmation buttons swap the fill to `status.danger` — do not
  invent a third neutral-filled variant.
- Keep labels to sentence case verbs ("Create workspace", not "CREATE").

## Accessibility

- Icon-only buttons require `aria-label`.
- Focus is always visible via the `border.focus` ring.
- The press animation is disabled under `prefers-reduced-motion: reduce`.
- Contrast: label-on-fill clears AA in both modes (`text.on-accent` flips
  between white and near-black with the mode).

## Shape ruling (2026-09-02)

`radius.control` moved from 5px to 7px, onto the same step as `radius.overlay`.
It is a token move, not a per-component one: a button, the input beside it, and the
popover it opens all soften together, and the ramp went from four steps to
three rather than gaining a fifth.

## Drift ruling (2026-08-05)

Reconciled against `src/renderer/src/components/ui/Buttons.tsx`. **The shipped
vocabulary wins on all three counts, and is now folded into the spec above
rather than listed as drift.**

- **Label padding** — 8px at xs/sm, 12px at md. The reference CSS's constant
  `0 var(--sem-space-lg)` predates the `xs` step; applied to a 26px control it
  is mostly padding.
- **`xs` size** — real, in use across dense chrome, and it has a token
  (`size.control.xs`). A ramp step the tokens already carry is not drift.
- **`OutlineButton`** — canonical. It is outlined rather than filled, so the
  one-accent rule is untouched.

Control **heights were never drift**: both the reference CSS and the shipped
code already sit on `size.control.*`. The drift ruling's own table listed a
28/32px prose ramp against the tokens' 26/30/34 — that prose is not in this
entry, and the numbers here come from the tokens.

## Shipped implementation

`src/renderer/src/components/ui/Buttons.tsx`, exporting `PrimaryButton`,
`SendButton` (the round send above, the composer's alone), `DangerButton`, `GhostButton`, `OutlineButton`, `IconButton`, `MediaButton`,
`CaptionButton` and `CloseIconButton` — the last being the canonical close
affordance named under Variants, exported separately so no surface has to re-pick
the glyph or the label. `CopyGlyphButton`
(`src/renderer/src/components/ui/CopyGlyphButton.tsx`) is the copy glyph above,
built on `IconButton` for the same reason.

The five shapes this family deliberately does **not** absorb each have an entry
of their own, and each says why: [row-button](../row-button/component.md),
[menu-option](../menu-option/component.md),
[trigger-button](../trigger-button/component.md),
[card-button](../card-button/component.md),
[chip-button](../chip-button/component.md) and
[link-button](../link-button/component.md).
