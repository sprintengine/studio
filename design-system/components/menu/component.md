# Menu

A list of actions, summoned onto a popover surface. Right-click a row, press a
kebab, or open a narrowing glyph: whichever way it was asked for, what appears
is this.

Use a menu when the list is *actions*. Use [select](../select/component.md) when
it is a value being chosen, [combobox](../combobox/component.md) when that value
has to be filtered for, and the detail pane when the answer is something to read
rather than something to do.

## Why this spec exists

The system shipped three menus and no spec, so each host answered the same
questions alone — and a row could be right-clicked and kebab-pressed into two
menus that disagreed about radius, border, ground, item type, hover shape and
divider colour. `OverflowMenu.tsx:200` admitted the split in a comment.

Measured 2026-08-05, before this ruling:

| | ContextMenu | OverflowMenu | FilterMenu |
|---|---|---|---|
| Surface radius | 6px | 7px (popover) | 7px (popover) |
| Surface border | `border.default` | `border.strong` | `border.strong` |
| Surface ground | `bg.surface` | `bg.surface-raised` | `bg.surface-raised` |
| Item type | body (13px) | meta (12px) | meta (12px) |
| Hover fill | inset, 4px radius | full-bleed | full-bleed |
| Divider | `border.subtle` | `border.default` | `border.subtle` |

## The rulings

Decided by what the rest of the system already does, not by counting.

**Surface: the popover shell, unchanged.** `popover/` is already the
anchored-overlay engine, and its own CSS says it carries no padding *"because a
menu wants full-bleed rows"* — the shell was written expecting this component.
ContextMenu is the outlier, and the only thing that actually distinguishes it is
that it positions at a **pointer** rather than an anchor. That is a positioning
difference. Nothing about a right-click justifies a different radius, border or
ground, and a person who opens the same actions two ways should not be able to
tell which way they used.

**Item type: `meta` (12px).** A menu item is chrome — it names an action; it is
not prose. At 13px a menu row also sits *above* the 12px list rows it was
usually summoned from, which reads as the menu mattering more than the thing it
acts on.

**Hover fill: full-bleed, no per-item radius.** An inset rounded fill inside a
padded surface reads as a card nested inside a card. Every other row list in the
system — `list-surface`, `context-rail`, `inbox-row` — fills to its own inset
instead, and a menu is a row list.

**Divider: `border.subtle`.** Inside an already-bordered surface a divider
separates siblings; at `border.default` it competes with the surface's own edge
and the menu reads as two stacked panels.

**Hover and keyboard highlight are one state.** A menu is walked with the arrow
keys as often as with the pointer, and "the row about to be activated" is one
idea. Two highlights for it is the same class of split this spec closes.

**Casing: sentence case, including a menu that stays native.** The product's
`principles.md` rule — *"sentence case everywhere except real keyboard
shortcuts"* — is a rule about the product's voice, so it does not stop at the
edge of a surface the OS draws. macOS conventionally Title-Cases its menus, and
that convention loses here: a native menu borrows the OS's metrics and
rendering, never its wording. "Close other editor tabs", not "Close Other
Editor Tabs". Keys stay keys. Which hosts may stay native at all is a separate
question, ruled per host and recorded with its reason.

### Why the losing values lost

- **13px items** — retired above: chrome, not prose.
- **6px radius** (`rounded-md`) — a radius off-ramp, and one step off the
  `radius.overlay` every other floating surface in the product uses. A menu is
  not a shape of its own.
- **`border.default` on `bg.surface`** — ContextMenu's border/ground pair
  described a *flat* surface. It floats, and floating chrome is already ruled:
  the popover shell's `border.strong` on `bg.surface-raised`. The weaker border
  on the lower ground made the same menu read as nearer the page when opened by
  right-click than when opened by kebab.
- **`border.default` dividers** — retired above, for `border.subtle`.
- **The inset rounded hover fill** — retired above, for full-bleed.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Surface | `.ds-popover` | yes — the shared shell, `role="menu"` |
| List | `.ds-menu` | yes — vertical padding only, so rows reach both edges |
| Item | `.ds-menu-item` | yes — `role="menuitem"` (or `menuitemradio` / `menuitemcheckbox`) |
| Leading slot | `.ds-menu-item-glyph` | all items in a menu, or none |
| Trailing hint | `.ds-menu-item-hint` | no — a shortcut, or a submenu chevron |
| Separator | `.ds-menu-separator` | no — `role="separator"` |
| Group label | `.ds-menu-group-label` | no — the alternative to a separator, not an addition |

The **leading slot is all-or-nothing per menu**. Give every item a glyph or give
none of them one: a menu where only some rows carry one ladders its own labels,
and the reader's eye loses the left edge it was tracking. Where a menu is
genuinely mixed, render the empty slot on the rows without a glyph rather than
letting their labels slide left.

## Surface

| Property | Token | Value |
|---|---|---|
| Radius | `radius.overlay` | 7px |
| Border | `border.strong` | 1px |
| Ground | `bg.surface-raised` | |
| Shadow | `shadow.popover` | |
| Padding | `space.2xs` vertical, none horizontal | 4px / 0 |
| Layer | `z.popover`, or `z.menu` when pointer-positioned | 50 / 60 |

The horizontal zero is the load-bearing part: it is what makes rows full-bleed,
and it is what an inset fill needs in order to look wrong.

A pointer-positioned menu sits one tier up, at `z.menu`, because it is summoned
*over* whatever is already open — including an open popover.

## Item

| Property | Token | Value |
|---|---|---|
| Type | `font.size.meta` | 12px |
| Padding | `space.xs` vertical, `space.md` horizontal | 6px / 10px |
| Gap | `space.sm` | 8px |
| Radius | none | full-bleed |

Vertical padding (6px) is deliberately what the three menus already agreed on
before this spec. A spec that moves values which were never divergent is a spec
nobody can adopt cheaply.

**The size travels with the item, never with the host.** A host that sets the
type size on the surface — including the surface of a submenu it opens — is
rebuilding the drift this spec closed.

## Divider

`border.subtle`, 1px, with `space.2xs` (4px) of air above and below. A group
label is the *alternative* to a divider, not an addition to it: one or the other
says "a new group starts here", and both together says it twice.

A group label is `font.size.micro` at `text.subtle`, on the item's own
horizontal inset so the heading and its rows share a left edge — quieter than
the rows, and never bolder. A heading that out-weighs the actions under it is
competing with them.

## Destructive item

Ink, never a fill: `tone.error` on the label, and the same `bg.hover` on hover
that every other row gets. A red row among black ones is read before it is aimed
at; a red *block* is read as something that has already happened.

There is no size variant, no tone variant beyond destructive, and no "compact"
menu. A menu that needs to be denser is a menu with too many items in it.

## Keyboard hints

A shortcut hint sits in the trailing slot as **mono `font.size.micro` (11px) at
`text.disabled`** — plain text, not [kbd-chord](../kbd-chord/component.md)
capsules. The chord is the right vocabulary where the shortcut is the subject
(a settings row that lists it, a walkthrough step that teaches it); in a menu it
is a footnote to an action the row already offers, and a line of capsules
out-weighs the label they annotate.

Carry a hint only for a shortcut that **works without the menu open** — the hint
teaches the reader how to skip this menu next time. A key that only works while
the menu is open is menu mechanics, not an accelerator, and belongs in the
keyboard contract below rather than painted onto a row.

Hints are `text.disabled` and right-aligned into a column, so they read as one
quiet annotation rather than as trailing content on each label.

## Submenu

A flyout item opens a nested menu beside itself. The nested surface is the
same material as its parent — same class, same tokens — and **inherits its type
size**; no host pins it.

**Anchoring.** The flyout opens at the parent item's right edge with a 2px gap,
pulled up by 5px (the surface's 4px vertical padding plus its 1px border) so its
first row top-aligns with the item that opened it. When the viewport is tight on
the right, it flips to open leftward of the item rather than sliding across and
covering the parent menu.

**Opening.** Hovering the trigger, clicking it, or pressing `ArrowRight`,
`Enter`, or `Space`. The trigger keeps the hover highlight while its flyout is
open, so the path back is visible.

**Closing.** `Escape` or `ArrowLeft` closes the flyout and returns focus to the
trigger; the pointer leaving both the trigger and the flyout closes it after a
short grace period, so crossing the gap between them does not dismiss it. A
choice inside the flyout dismisses the whole menu the way any item does — by
the consumer closing it, which is what lets a toggle row leave it open.

**Structure.** The trigger is a `menuitem` with `aria-haspopup="menu"` and
`aria-expanded`, and a trailing chevron. The nested surface is its own `menu`
with its own accessible name and its own roving focus — each surface roves only
its own level. It stays inside the parent menu's DOM so a click in the flyout
reads as a click inside the parent.

## States

- **Rest** — transparent; the surface is the only ground.
- **Hover / active** (`data-active="true"`) — `bg.hover`, ink lifts to
  `text.primary`. One state for both pointer and keyboard.
- **Focus-visible** — the shared ring, drawn *inset*, because a full-bleed row
  touches the surface border and an outset ring straddles it.
- **Disabled** — the whole row dims to 45% and the cursor says not-allowed. It
  dims rather than re-inking because the row is label *plus* leading glyph plus
  hint, and an ink rule reaches only the label. Kept in the list rather than
  removed: a control that vanishes when unavailable teaches nothing, and the gap
  it leaves moves every row below it.

## Accessibility

- The surface is `role="menu"`; items are `role="menuitem"`, or
  `menuitemradio` / `menuitemcheckbox` when they carry a selected state.
- Focus moves through items with `ArrowUp` / `ArrowDown`, wrapping. `Home` and
  `End` jump to the ends. `Escape` closes the menu and returns focus to the
  trigger that opened it — the menu never leaves focus on `<body>`.
- The trigger carries `aria-haspopup="menu"` and `aria-expanded`.
- A checked item states it with `aria-checked`, not with the tick glyph alone.
- Disabled items carry the `disabled` attribute and are skipped by the arrow
  keys, so the keyboard walk only ever lands on rows that do something. They
  stay visible, and their dimmed state is what says why they were skipped.

## Retired — reject these on sight

Both shipped, both are named here by where they lived so a reviewer can
recognise them coming back:

1. **Host-pinned item size** — `OverflowMenu.tsx:200` (pre-convergence) passed
   `text-meta` onto the surface of every flyout it opened, with a comment
   explaining that the nested surface's own base class was "the 13px right-click
   idiom". A host that knows it must correct another component's type size is
   evidence the size lives in the wrong place. The size now travels with the
   item; a new pin is a regression, not a fix.
2. **Literal danger hover** — `ui/ContextMenu.tsx:257` (pre-convergence) drew
   the destructive row's hover as `rgba(255, 120, 124, 0.08)`: a raw colour
   invisible to the token system, and a second signal saying what the ink
   already said. Destructive rows hover like every other row.

## Shipped implementation

`src/renderer/src/components/ui/ContextMenu.tsx` (pointer-positioned, and the
`MenuItem` / `MenuDivider` / `MenuFlyoutItem` / `MenuSwatchRow` vocabulary —
`MenuSwatchRow` being the one row that is not a label, a line of colour swatches
for picking a workspace accent without leaving the menu),
`OverflowMenu.tsx` (the kebab), `FilterMenu.tsx` (the narrowing glyph).

**Reconciled 2026-08-05.** `ContextMenu` moved furthest: onto the popover shell
(7px radius, `border.strong`, `bg.surface-raised`), vertical-only padding so its
rows are full-bleed, `meta` items instead of `body`, an inset focus ring, and
the retired hover literal above. `OverflowMenu`'s divider moved from
`border.default` to `border.subtle`. `FilterMenu` already met the spec.

The values then moved out of the components and into one shared class pair,
`ui/menuClasses.ts` — the surface and the item — which is what makes a host
unable to drift: a component that takes `MENU_ITEM_CLASS` gets the size, the
full-bleed geometry, the one highlight state and the inset ring together, and
has nothing left to answer for itself. Every menu host now consumes it, and the
flyout size pin above is gone with it.

`SplitButton`'s alternatives list and `Select`'s listbox belong to the same
family: same chrome, same row geometry, same highlight. A select option keeps
`body` (13px) rather than `meta`, because its popup echoes strings its trigger
is already showing at that size and picking a value must not resize it
([select](../select/component.md)). A menu item has no such at-rest twin, which
is why 12px is right here and not there.

Held by `ui/designSystemAxes.test.ts`, whose menu checks take **this document —
`design-system/components/menu/component.md` — as their source of truth**, and
which compares the three components against each other rather than each against
itself: the divergence only ever existed *between* components, so a
per-component test could not have caught it.
