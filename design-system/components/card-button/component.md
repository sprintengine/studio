# Card button

A block-level button whose content is a **composition** rather than a label: a
preview frame over two caption lines, a swatch over a name, a summary tile with
a glyph and a live count, a graph node the canvas positions itself.

Use [task-card](../task-card/component.md) when the thing is a card on a board.
Use [row-button](../row-button/component.md) when the thing is a row in a list.
Use this when the thing is a **tile in a grid**.

## The rule

**Hover changes the ground, and nothing else.** No border appearing, no shadow,
no scale, no size change of any kind. A tile lives in a grid, and a grid that
reflows under the pointer is the defect — `principles.md` already forbids "a
border appearing on hover and shifting the layout", and elevation in the
document flow is what the hairline clause rules out for anything that is not a
pressable control standing on its own.

That single rule is why this is not [button](../button/component.md)'s outline
variant with a column flow. The outline variant carries `shadow.control-edge`,
pins a `size.control.*` height, centres its label and sets `font.weight.medium`
— four decisions a tile has already made for itself, and four that a caller
cannot reliably cancel, because two `justify-*` or two `height` declarations on
one element are resolved by stylesheet order.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Tile | `.ds-card-button` | yes — a `<button>` |
| Title | `.ds-card-button-title` | no — `font.size.body`, `font.weight.medium` |
| Supporting line | `.ds-card-button-supporting` | no — `font.size.meta`, `text.subtle` |
| Content | — | the caller's: a preview frame, a swatch, an image, a glyph |

The component states **no padding**. A tile's inset is part of its composition —
a preview frame wants `space.2xs`, a summary tile wants `space.lg` over
`space.md` — so it is the caller's, and a default here would be one more
utility every caller had to out-specify.

## Variants

- **Default** — no edge. The tile *is* its content: a preview iframe, a
  specimen, a picture. The hover ground is the whole affordance.
- **`--bordered`** — a `border.default` hairline over `bg.surface`, lifting to
  `border.strong`. For a tile whose content does not draw its own box. The
  hairline is present **at rest**, which is what lets it lift on hover without
  moving anything.

## States

| State | Treatment |
|---|---|
| Rest | Transparent (or the hairline over `bg.surface`) |
| Hover | `bg.hover` ground; on `--bordered`, the border also lifts to `border.strong`. Nothing else changes |
| Selected | `bg.selected` fill, ink at `text.primary`, 2px inset `accent.primary` edge. Hover **not applied** |
| Focus-visible | The shared ring |
| Disabled | 45% opacity, `not-allowed`, hover suppressed |
| Pressed | **Nothing.** No scale — see The rule |

Hover is *excluded* from the selected state rather than repainted over it, for
the reason [row-button](../row-button/component.md) documents: `bg.hover` sits
below `bg.selected`, so a selected tile under the pointer would dim.

## Usage

- **A grid of offers takes the accent on every card's action, not on one**
  (`principles.md` → The storefront exception). That is about the button *inside*
  a card; the card itself never takes the accent as a fill.
- **A live count or no line at all.** A number nobody has measured yet is no
  line; a number that really is nothing is words ("No runs", "None installed").
- Keep the tile's own content to a title, one supporting line, and at most one
  live fact. A tile that needs more is a row.

## Accessibility

- **Selection announces as `aria-pressed`.** A tile in a grid of alternatives is
  a choice you throw; a row in a list is somewhere you are, and reads
  `aria-current`. The two are deliberately different, and mixing them within one
  surface is the defect that distinction prevents.
- The tile is one tab stop and one accessible name. A tile that contains a
  second control is a card with actions, not a card button — split them.
- `style`, `data-*` and the rest pass through untouched, because the canvas
  cases position and size themselves.

## Shipped implementation

`src/renderer/src/components/ui/CardButton.tsx`, exporting `CardButton` with
`variant` and `selected`.
