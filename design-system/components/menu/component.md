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
divider colour. `OverflowMenu.tsx:200` admits the split in a comment.

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

## Anatomy

| Part | Class | Required |
|---|---|---|
| Surface | `.ds-popover` | yes — the shared shell, `role="menu"` |
| List | `.ds-menu` | yes — vertical padding only, so rows reach both edges |
| Item | `.ds-menu-item` | yes — `role="menuitem"` (or `menuitemradio` / `menuitemcheckbox`) |
| Leading slot | `.ds-menu-item-glyph` | reserved on every item once any item has one |
| Trailing hint | `.ds-menu-item-hint` | no — a shortcut, a count, a submenu chevron |
| Separator | `.ds-menu-separator` | no — `role="separator"` |
| Group label | `.ds-menu-group-label` | no — the alternative to a separator, not an addition |

The **leading slot is reserved by the menu, never sized by the item**. A menu
where only some rows carry a glyph would otherwise ladder its own labels — the
same defect the context rail's row icon slot fixes, and the same fix.

## Variants

**Destructive** (`data-destructive="true"`) is ink, never a fill. A red row among
black ones is read before it is aimed at; a red *block* is read as something that
has already happened.

There is no size variant, no tone variant beyond destructive, and no "compact"
menu. A menu that needs to be denser is a menu with too many items in it.

## States

- **Rest** — transparent; the surface is the only ground.
- **Hover / active** (`data-active="true"`) — `bg.hover`, ink lifts to
  `text.primary`. One state for both pointer and keyboard.
- **Focus-visible** — the shared ring, drawn *inset*, because a full-bleed row
  touches the surface border and an outset ring would be clipped by it.
- **Disabled** — `text.disabled`, no fill, `aria-disabled`. Kept in the list
  rather than removed: a control that vanishes when unavailable teaches nothing,
  and the gap it leaves moves every row below it.

## Accessibility

- The surface is `role="menu"`; items are `role="menuitem"`, or
  `menuitemradio` / `menuitemcheckbox` when they carry a selected state.
- Focus moves through items with `ArrowUp` / `ArrowDown`, wrapping. `Home` and
  `End` jump to the ends. `Escape` closes the menu and returns focus to the
  trigger that opened it — the menu never leaves focus on `<body>`.
- The trigger carries `aria-haspopup="menu"` and `aria-expanded`.
- A checked item states it with `aria-checked`, not with the tick glyph alone.
- Disabled items keep `aria-disabled="true"` rather than the `disabled`
  attribute where they must stay arrow-reachable, so a keyboard user can read
  what is unavailable instead of skipping past it silently.

## Shipped implementation

`src/renderer/src/components/ui/ContextMenu.tsx` (pointer-positioned, and the
`MenuItem` / `MenuDivider` / `MenuFlyoutItem` vocabulary),
`OverflowMenu.tsx` (the kebab), `FilterMenu.tsx` (the narrowing glyph).

**Reconciled 2026-08-05.** All three now meet this spec. `ContextMenu` moved
furthest: onto the popover shell (7px radius, `border.strong`,
`bg.surface-raised`), vertical-only padding so its rows are full-bleed, `meta`
items instead of `body`, an inset focus ring, and its destructive row lost a raw
`rgba(255,120,124,0.08)` hover tint — a second signal saying what the ink
already said. `OverflowMenu`'s divider moved from `border.default` to
`border.subtle`. `FilterMenu` already met the spec.

Held by `ui/designSystemAxes.test.ts`, which compares the three against each
other rather than each against itself — the divergence only ever existed
*between* components, so a per-component test could not have caught it.

Item vertical padding (6px) is deliberately unchanged: all three already agreed
on it, and a spec that moves values which were never divergent is a spec nobody
can adopt cheaply.
