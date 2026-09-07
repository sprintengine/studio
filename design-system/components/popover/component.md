# Popover

The anchored overlay engine. One surface, lifted to the end of `<body>` and
positioned in fixed viewport coordinates, so it escapes every scroll container
and stacking context on the page. Everything dropdown-shaped in the product —
overflow menus, filter menus, select listboxes, pickers — composes this shell
rather than owning its own portal, its own Escape handler, and its own
outside-click logic. Extracted from the source product's `Popover` and
`PointerPopover` primitives (`src/renderer/src/components/ui/`).

Use a tooltip instead when the content is a description and nothing in it is
clickable — a surface that can swallow a click is a popover, and the two have
different keyboard contracts. Use a modal when the task must block the page: a
popover is light-dismiss by design and never scrims.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Trigger | — | the consumer's own control, carrying `aria-haspopup`, `aria-expanded`, and — only while open — `aria-controls` |
| Surface | `.ds-popover` | yes — `role="menu"`, `"listbox"`, or `"dialog"`, with a required `aria-label` and a stable `id` |
| Content | — | host-owned; the shell carries chrome only and no padding of its own |

The shell decides the border, radius, background, shadow, layer, and entrance.
It deliberately carries **no padding**: a menu list wants full-bleed rows with
vertical inset, a dialog-role body wants an even inset, and neither should
fight a default. Content padding belongs to the content.

Position is written by the consumer as viewport coordinates into the custom
properties `--ds-popover-top`, `--ds-popover-right`, `--ds-popover-bottom`,
and `--ds-popover-left` — set the one or two edges that anchor the surface and
leave the rest `auto`. Anchor by the edge nearest the trigger (left for a
`start` placement, right for `end`; bottom when flipped above) so the surface's
measured size never enters the math on its anchored axis: the glued edge cannot
drift by a surface-width when a measurement is momentarily stale. The consumer
also mirrors the trigger's width into `--ds-popover-trigger-width` so
width-coupled surfaces (a select's listbox) can set
`min-width: var(--ds-popover-trigger-width)` without an inline width clobbering
their own floor.

## Variants

- **Placement** — `bottom-start` (default), `bottom-end`, `top-start`,
  `top-end`. A placement is a preference, not a promise: the surface flips to
  the other vertical side when its preferred side has no room, and clamps `8px`
  inside the viewport on both axes. The clamp bounds height as well as
  position: a surface taller than the viewport is capped to it and scrolls
  its content, so the last rows of a long menu are never off-screen. The gap
  between trigger and surface is `4px`.
- `.ds-popover--pointer` — coordinate-anchored instead of trigger-anchored:
  opens at a viewport point (a right-click, a text caret, a drop location) and
  clamps inside the viewport. It sits at `z.menu`, one layer above the
  trigger-anchored surface, because a context menu is summoned *over* whatever
  is already open — including an open popover. Same shell, same chrome; only
  the anchor and the layer differ. In the shipped kit this is `PointerPopover`
  (rich coordinate-anchored content) and the surface `ContextMenu` shares.

- **Material** — `raised` (default) or `glass`. Raised is the ordinary
  surface. Glass is `bg.surface-raised` at `glass.opacity` over a
  `backdrop-filter` of `glass.blur` and `glass.saturation`, and it is opt-in
  per surface, never the family default: it exists for a card drawn
  deliberately over live app content that the reader should still see (the
  conversation peek over a running terminal; the composer's skill type-ahead
  over the transcript being read). Elevation and radius do not change with
  it — the popover family keeps `shadow.popover` and `radius.overlay` in both
  materials. Both shells carry it: the trigger-anchored surface (`Popover`,
  since 2026-09-08) and the pointer-anchored one (`PointerPopover`). See the
  toast spec for the blur ruling this opts into; nothing outside the kit may
  borrow the utility.

There is no arrow variant. A caret pointing at the trigger is decoration the
4px gap already does the work of, and it forces the surface to track the
trigger horizontally instead of clamping freely.

## States

| State | Treatment |
|---|---|
| Closed | Not in the document (or `hidden`) — out of view and out of the accessibility tree |
| Open | Entrance: a 4px drop-and-fade at `motion.duration.normal` / `motion.ease.standard` — the one sanctioned popover entrance; removed under reduced motion |
| Open, trigger scrolled | The surface **repositions** to track its trigger (scroll in the capture phase, and resize) — unlike a tooltip, which dismisses, because a popover holds state a scroll must not throw away |
| Stacked | A popover opened from inside another stacks above it; each keeps its own surface |

Until the first measurement lands, the surface is kept invisible so the first
paint never flashes at 0,0.

## Usage

**Light dismiss, exactly three ways.** Escape, a pointer-down outside, or the
consumer closing it (picking an item, toggling the trigger). No scrim: the page
stays visible and clickable-through-to — the outside click that dismisses also
lands where it fell.

**Escape closes the topmost surface only.** Open popovers form a stack; an
Escape consumed by the top one never reaches the one below, and never reaches a
dialog hosting them. One press, one layer.

**A pointer landing in a surface stacked above counts as inside.** Every
surface is portaled to `<body>`, so a popover opened from inside another is not
a DOM descendant of it — a naive `contains()` check reads a click on the nested
surface as an outside click and unmounts it before its own click lands,
silently dropping the choice the user just made. This clause exists because
that was a real defect.

**The popup role is a contract, not a default.** `role="menu"` for action
lists, `role="listbox"` for selection, `role="dialog"` for rich content (a
search field, a form). The trigger's `aria-haspopup` mirrors whichever the
surface declares, so a screen reader hears what kind of surface Enter will
open. Content then owes that role its keyboard behavior — a menu roves focus
with arrows; the shell does not do this for you.

**Do not rebuild the shell per host.** Escape stacking, outside-press logic,
focus restoration, and clip-escape are solved here once. A surface that owns
its own copy of any of them will drift — the shipped codebase has bespoke
popover chrome in notification and workspace surfaces, and every one answers
these questions slightly differently.

**Rebuilding it in a framework:** what must survive the rewrite is the portal
to `<body>`, the edge-nearest-trigger anchoring, the topmost-only Escape, the
stacked-above outside-press guard, and focus returning to the trigger on close.

## Accessibility

- The surface carries its role and a **required** `aria-label` — a portaled
  surface has no surrounding context to borrow a name from.
- The trigger carries `aria-haspopup` matching the popup role, `aria-expanded`
  for the open state, and `aria-controls` pointing at the surface's `id` **only
  while it is open** — a reference to a node that is not in the document is
  noise.
- Closing returns focus to the trigger, so Escape never strands keyboard focus
  on `<body>`. Closing because the user clicked elsewhere skips the restore —
  focus follows the click.
- Escape is handled on the document, before window-level listeners, so a
  hosting dialog keying its own Escape off `defaultPrevented` sees the popover
  consume it first regardless of mount order.
- The entrance animation is removed under `prefers-reduced-motion: reduce`.

## Known drift

None. Both entries that stood here were spent by **MC-2110** and verified gone
on 2026-09-02:

- ~~Six shipped files hardcode the dark-only shadow
  `0 8px 24px -12px rgba(0,0,0,0.6)`, so light-mode overlays cast a dark-tuned
  shadow and `--sem-shadow-popover` goes unconsumed.~~ **Resolved** — the
  literal appears nowhere in the renderer, and the
  `MC-2110 no overlay spells its own shadow` seam holds it there.
- ~~`Popover.tsx` writes `rounded-[7px]`, which matches `radius.overlay` but
  bypasses the variable.~~ **Resolved** — it draws the radius through the
  variable.

Recording this rather than deleting the section: a spec that lists drift which
was fixed two sweeps ago teaches a reader to expect a defect that is not there,
and to distrust the rest of the entry. The drift log is a list to drain.
