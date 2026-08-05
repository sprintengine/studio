# Tooltip

The description for a value the surface itself cannot show: a title truncated
to one line, an icon-only control's name, a path abbreviated to its tail. It
elaborates what is already on screen, and never becomes the only route to a
value: the detail pane, a menu, or the control's own accessible name still
carries it.

One surface on screen at a time. A list of 200 rows puts one tooltip in the
document, not 200 — the surface exists only while a tooltip is shown.

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
| Shown from pointer | Appears after a short hover delay over the trigger (~200 ms shipped) |
| Shown from keyboard | Appears immediately on `:focus-visible` |
| Default side | Above the trigger, `6px` clear of it, horizontally centred |
| Overridden | A consumer may name a side per trigger — load-bearing where the default has no room (see the ruling below) |
| Flipped | The opposite side, when the chosen one has no room; then clamped inside the viewport |

The surface has no entrance animation. It is neither *alive right now* nor
*just changed* — the two things motion is allowed to mean — and the pointer
delay already does the pacing a fade would be reaching for.

## Usage

**Both paths, always.** Shown on pointer-over **and** on `:focus-visible`.
Hover-only fails the same progressive-disclosure clause that governs row
actions. `:focus-visible` and not `:focus`: clicking a control must not draw a
tooltip over the thing that was just clicked.

**The delay is asymmetric on purpose.** A short delay on pointer, so crossing a
list does not fire every row in turn; none on keyboard focus, because there is
no crossing to absorb.

**Four ways out**, all of them cheap: the pointer leaves the trigger, focus
leaves it, Escape, or any scroll. Scroll dismissal is not optional — a fixed
surface anchored to a row that has scrolled away is pointing at nothing. Listen
for scroll in the capture phase so nested containers dismiss too.

**Never interactive.** `pointer-events: none`. Anything clickable belongs in a
popover, which is a different component with a different keyboard contract.

**Flip, do not shrink.** Flip to the opposite side when the chosen one has no
room, and clamp inside the viewport rather than resizing the surface. Where a
whole surface's default side is wrong — a right-docked pane, a row at the top of
a window — name the side per trigger instead of relying on the flip.

**Restate a value only when it is actually cut off.** When the tooltip's job is
to repeat a title the row truncated, compare `scrollWidth` with `clientWidth`
and attach only when it overflows — on text that fits it repeats what the
person can already read. A tooltip that instead *adds* a description the row
has no room for is a different job, and that description has to stay reachable
without hovering.

**Touch has no hover.** Anything a tooltip explains must also be reachable
without one — in the detail pane, an overflow menu, or the accessible name of
the control itself.

**Rebuilding it in a framework:** the requirement is that the *document* holds
one surface at a time, not that one surface object is reused. A component that
portals its surface on open and tears it down on close satisfies it, and keeps
each trigger's content and `aria-describedby` wiring local — which is what
ships. What this component exists to prevent is 200 rows putting 200 surfaces in
the document *at rest*; a per-trigger component that renders nothing until shown
does not do that. When a subtree forces `data-mode`, mirror that mode onto the
surface — it sits on the body and would otherwise be lit by the document's mode
instead of the container's.

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

## Drift ruling (MC-2118, 2026-08-05)

Reconciled against `src/renderer/src/components/ui/Tooltip.tsx`. The three
drifts do not resolve the same way, so each is ruled on its own.

**Type and padding — the spec wins; the code moved.** Shipped was
`font.size.micro` (11px) with 8/4px padding, which put the tooltip a type step
*below* the 12px row it exists to make readable. That is backwards for a
component whose entire job is to show what the surface could not. Now
`font.size.meta` at 10/6px.

**Architecture — the code wins; this spec was over-specified.** "One surface
per document, positioned by `--ds-tooltip-top/left`" described an
implementation, not a property. What actually matters is that a 200-row list
does not put 200 surfaces in the document, and the shipped component already
guarantees that: the portal is created *on open* and torn down on close, so the
document holds one at a time regardless of how many triggers exist. A singleton
surface driven by custom properties would need a global controller and would
have to re-derive each trigger's content and `aria-describedby` wiring, trading
a real cost for a naming preference. The lede above now states the property
rather than the mechanism.

**Placement and delay — the code wins.** A per-trigger `placement` prop is
load-bearing, not a convenience: the app's own context rail documents why
(`top` sent the topmost row's tip into the macOS traffic-light zone, where the
viewport clamp pinned it to the window corner). The 200ms delay is a shipped
product decision and this entry has no better one to offer.
