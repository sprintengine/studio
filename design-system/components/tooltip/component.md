# Tooltip

The description for a value the surface itself cannot show: a title truncated
to one line, an icon-only control's name, a path abbreviated to its tail. It
elaborates what is already on screen, and never becomes the only route to a
value: the detail pane, a menu, or the control's own accessible name still
carries it.

One surface per document, repositioned per trigger. A list of 200 rows mounts
one tooltip, not 200.

Use a popover instead when the content is interactive, a menu when it is a list
of actions, and the detail pane when the value is long enough to read rather
than glance at. Never a native `title` attribute on a control: it is
unstyleable, slow, invisible to touch, and inconsistent between browsers.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Trigger | — | the consumer's own element, carrying `aria-describedby` only while the surface is shown |
| Surface | `.ds-tooltip` | yes — `role="tooltip"`, a stable `id`, `hidden` at rest |
| Title | `.ds-tooltip-title` | no — the identifier the description elaborates |

The surface lives at the end of `<body>`, not beside its trigger, so it escapes
every scroll container and stacking context on the page. Position comes from
two custom properties the consumer writes in viewport coordinates:
`--ds-tooltip-top` and `--ds-tooltip-left`.

Content is one short description — at most a couple of lines. A tooltip that
needs a heading, a list, or a link is the wrong component.

## Variants

None. A tooltip has one appearance, and the only optional part is the title.

There is no arrow, no tone variant, and no size variant. An error or warning
tooltip in particular is a rejected idea: a state a person must act on is never
disclosed on hover.

## States

| State | Treatment |
|---|---|
| Rest | `hidden` — out of view and out of the accessibility tree |
| Shown from pointer | Appears after ~350 ms of hover over the trigger |
| Shown from keyboard | Appears immediately on `:focus-visible` |
| Preferred side | Inline-start of the trigger, `8px` clear of it, vertically centred |
| Flipped | Inline-end instead, when the preferred side has no room; then clamped inside the viewport |

The surface has no entrance animation. It is neither *alive right now* nor
*just changed* — the two things motion is allowed to mean — and the pointer
delay already does the pacing a fade would be reaching for.

## Usage

**Both paths, always.** Shown on pointer-over **and** on `:focus-visible`.
Hover-only fails the same progressive-disclosure clause that governs row
actions. `:focus-visible` and not `:focus`: clicking a control must not draw a
tooltip over the thing that was just clicked.

**The delay is asymmetric on purpose.** ~350 ms on pointer, so crossing a list
does not fire every row in turn; none on keyboard focus, because there is no
crossing to absorb.

**Four ways out**, all of them cheap: the pointer leaves the trigger, focus
leaves it, Escape, or any scroll. Scroll dismissal is not optional — a fixed
surface anchored to a row that has scrolled away is pointing at nothing. Listen
for scroll in the capture phase so nested containers dismiss too.

**Never interactive.** `pointer-events: none`. Anything clickable belongs in a
popover, which is a different component with a different keyboard contract.

**Flip, do not shrink.** Prefer the inline-start side and flip when there is no
room. This is load-bearing for a right-docked pane, where the natural side is
off-screen.

**Restate a value only when it is actually cut off.** When the tooltip's job is
to repeat a title the row truncated, compare `scrollWidth` with `clientWidth`
and attach only when it overflows — on text that fits it repeats what the
person can already read. A tooltip that instead *adds* a description the row
has no room for is a different job, and that description has to stay reachable
without hovering.

**Touch has no hover.** Anything a tooltip explains must also be reachable
without one — in the detail pane, an overflow menu, or the accessible name of
the control itself.

**Rebuilding it in a framework:** keep the single shared surface. Mounting one
per row is the defect this component exists to prevent, and it is the easy
mistake to make in a component tree. When a subtree forces `data-mode`, mirror
that mode onto the surface — it sits on the body and would otherwise be lit by
the document's mode instead of the container's.

## Accessibility

- The surface carries `role="tooltip"` and a stable `id`. The trigger carries
  `aria-describedby` pointing at that `id` **only while it is shown**, so a
  screen reader announces the description at the moment it appears rather than
  on every trigger in the list.
- `aria-describedby`, never `aria-labelledby`: a tooltip describes a control,
  it does not name one. An icon-only button still needs its own `aria-label`,
  and the tooltip says something that label does not — the consequence of the
  action, not a restatement of its name.
- The trigger must be focusable. A tooltip on a `<div>` nobody can Tab to is
  unreachable for keyboard and screen-reader users.
- Escape dismisses, matching the overlay rule that Escape closes the topmost
  surface only. The tooltip never takes focus, so nothing has to be restored.
- The surface is never the only place a value exists. It is an elaboration of
  on-screen content, so a person who cannot summon it loses nothing they cannot
  reach another way.
- Contrast is `text.default` on `bg.surface-raised` in both modes. Do not drop
  the description to `text.subtle` to make it feel secondary — it is already
  secondary by being hidden.

## Known drift

Verified against `src/renderer/src/components/ui/Tooltip.tsx` (2026-08-04):

- **Type and padding.** This spec (and the reference CSS) says
  `font.size.meta` with `space.xs` / `space.md` padding (6/10px); shipped is
  `font.size.micro` (11px) with `px-2 py-1` (8/4px), ink at `--text-strong`
  on a `border.strong` hairline.
- **Architecture.** Shipped mounts a portal **per trigger instance** (created
  on open — one visible at a time, but N instances across a list), the exact
  pattern this spec rules out for 200-row lists; the single shared surface
  positioned by `--ds-tooltip-top/left` is not what ships.
- **Placement and delay.** Spec prefers inline-start, 8px clear, ~350ms
  pointer delay; shipped defaults to `top` with a 6px gap, a per-trigger
  `placement` prop, and a 200ms delay.

MC-2118 owns the reconciliation.
