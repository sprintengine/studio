# Menu option

The menu row that shows a **choice** rather than an action.

[menu](../menu/component.md) specifies the action row — "Rename", "Delete", a
shortcut hint on the right — and it is complete for that job. This is its
sibling: the row that says *this is the value in force*. A machine in a checkout
popover, a model in a picker, a filter axis, a theme, an attach-path suggestion.

It is a separate entry rather than a variant of the menu item because the three
things that differ are all things a class cannot carry.

1. **The role belongs to the caller.** The same row is `option` inside a
   listbox, `radio` inside a radiogroup, `menuitemradio` inside a menu that
   picks one of a set, and `menuitemcheckbox` when it is a standing toggle. The
   menu item hard-codes the menu family, which is right for an action and wrong
   for a value.
2. **Selection is a rendered state.** It paints the neutral fill, it suppresses
   hover while it does, and it emits the aria attribute *that role* actually
   uses — `aria-selected` for an option, `aria-checked` for the three checkable
   roles. Emitting the wrong one fails silently: the row reads as having no
   state at all.
3. **The tab stop belongs to the caller.** A radiogroup or a listbox is **one**
   tab stop, and it lands on the row carrying the current value. The menu item
   hard-codes `tabindex="-1"`, which is right inside a menu with roving focus
   and wrong for a group the page tabs into.

The consuming product had twenty-odd of these as raw `<button>` elements wearing
the menu item's class string — the chrome reproduced faithfully, the state
restated per host, and four hosts getting the hover rule wrong.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-menu-option` | yes — a `<button>` carrying an explicit `role` |
| Leading glyph | — | no — the caller's node, sized and coloured by the caller |
| Text | `.ds-menu-option-text` | only in the stacked shape |
| Name | `.ds-menu-option-name` | in the stacked shape — `font.size.body` |
| Supporting line | `.ds-menu-option-supporting` | no — `font.size.meta`, `text.subtle`, one line |
| Trailing mark | `.ds-menu-option-mark` | no — the tick, a value, a chevron |
| Stacked shape | `.ds-menu-option--stacked` | no |

Geometry is the menu item's, exactly: `space.xs` block and `space.md` inline
inset, `space.sm` gap, full-bleed with no radius, the inset ring. A picker and
the right-click menu beside it must be made of the same material.

## Variants

- **Flat** (no modifier) — one line at `font.size.meta`. The default.
- **`--stacked`** — a name over a supporting line, with the glyph and the
  trailing mark aligned to the **first** line. This is the same second shape the
  menu entry sanctions and for the same reason: a two-line row that centres its
  icon puts the glyph against the gap between the lines. It states no font size
  of its own — each line names one, and a size on the ancestor would be a third
  `font-size` for the cascade to resolve.

## States

| State | Treatment |
|---|---|
| Rest | Transparent, `text.default` |
| Hover | `bg.hover`, ink lifts to `text.primary` — **only while not selected** |
| Selected | `bg.selected` fill, `text.primary` ink, hover **not applied** |
| Focus-visible | The shared ring, drawn **inset** |
| Disabled | 45% opacity, `not-allowed`, no fill in any state |

**The hover rule is the whole point of the component.** `bg.hover` sits below
`bg.selected` on the surface ramp, so a chosen row that also took the hover step
dimmed under the pointer — which reads as the row letting go of the choice.
Suppressing it by writing a second `hover` fill beside the first is two
declarations of one property at equal specificity, resolved by stylesheet order;
the fix is that the selected row never receives the hover step at all.

Selection is **neutral, never the accent**. A chosen value is a selection, and
the accent is spent on the view's one primary action.

## Usage

- **One option per value, and the group states its own role.** A `listbox` of
  options, a `radiogroup` of radios, a `menu` of `menuitemradio` rows — the
  container's role and the rows' roles are one decision, made together.
- **A held trailing mark, not a moving one.** Where the tick is the only thing
  that distinguishes the chosen row's width, render it hidden rather than absent
  so the rows do not reflow as the choice moves.
- Mix option rows and action rows in one surface only when a divider separates
  them: a list of values with a "Manage…" row at the foot is two kinds of row,
  and the divider is what says so.

## Accessibility

- The role is required, and the state attribute follows from it. Both the
  chosen and the unchosen rows carry it: a group whose unchosen rows have **no**
  state attribute announces as a list of plain buttons, which is the failure the
  role was added to prevent.
- **`aria-expanded` marks a drill-in.** A row that opens a sub-surface rather
  than committing a value says so; without it the row announces as a choice that
  never takes effect.
- The row passes `tabIndex`, `data-*`, `onKeyDown` and `disabled` through, so
  the host owns roving focus and the position of the group's single tab stop.
- A disabled row takes no fill in any state. CSS `:hover` still matches a
  disabled button, so without the guard every picker painted an "about to be
  activated" highlight onto rows that cannot be activated.

## Shipped implementation

`src/renderer/src/components/ui/MenuOption.tsx`, exporting `MenuOption`. The
shared geometry lives in `src/renderer/src/components/ui/menuClasses.ts` as
`MENU_OPTION_CLASS` / `MENU_OPTION_STACKED_CLASS` — the menu item's shape with
the hover step split out into `MENU_ROW_HOVER_CLASS`, which is what lets the
selected row simply not receive it.
