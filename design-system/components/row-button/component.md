# Row button

The list ROW as a control: full width, left-aligned, content height, and its
layout in its children.

It is the button family's full-bleed member, and it exists because the family
had no such member. [button](../button/component.md) answers *a thing you
press* — `inline-flex … justify-center` on a `size.control.*` step with a label
weight of its own. [list-row](../list-row/component.md) answers *a worklist row*
— a title, a supporting line, a trailing meta, revealed actions, at most four
elements at rest. Between them sits the row that is neither: a rail entry with
three stacked lines, a listbox option, a settings rail tab, a skill file path
with a size on the end, a "New …" affordance.

A sweep of the consuming product on 2026-09-08 found **forty of those**, each a
raw `<button>`, and every one of them started by cancelling four things the
button base had decided: the ramp height, the centring, the `font-weight`, and
the gap. In a utility-class stack that cancellation is not reliable — two
`justify-*` or two `h-*` on one element are resolved by stylesheet order — so
this is not a convenience wrapper. It is the shape stated once so it cannot be
half-stated forty times.

**Which to reach for.** If the row is the worklist row `list-row` describes,
use that. If the row is an option, a rail entry, a tab or a create affordance —
or if its content is a composition rather than a title and a supporting line —
use this.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-row-button` | yes — always a `<button>` |
| Density | `--nav` / `--bleed` / `--flush` | no — the default is the inset row |
| Variant | `--dashed` | no — the create affordance |
| Contents | — | yes, and they are the CALLER's: a glyph slot, one or more lines, a trailing gutter |

The component states **no height, no `justify-content`, no font weight and no
gap between the lines**. Those are the composition, and the composition differs
per surface; what does not differ is the width, the ground, the selection
treatment, the focus ring and the disabled canon, which is the whole of what is
here.

## Variants

- **Default** — no modifier. `border.default`-free, transparent, `radius.overlay`,
  `space.xs`/`space.sm` inset. The inset row inside a padded rail.
- **`--dashed`** — a 1px dashed `border.default` and `text.muted` ink. The
  "New …" affordance, which the [list surface anatomy](../../foundations/principles.md)
  puts first and full width at the very top of every rail. This is the **only
  dashed edge in the system**, and the condition is load-bearing: the row is a
  place for a thing that does not exist yet. A dashed edge anywhere else is
  decoration.

## Density

Four steps, and each is a statement about what the row TOUCHES.

| Density | Radius | Ground | Focus ring | For |
|---|---|---|---|---|
| `row` (default) | `radius.overlay` | its own | outset | an inset row in a padded rail |
| `--nav` | `radius.overlay` | its own | outset | the sidebar's rhythm — a `size.control.sm` floor so a one-line door row matches the controls above it |
| `--bleed` | none | its own | **inset** | a full-bleed row in a list that reaches its container's edges |
| `--flush` | none | **none** | **inset** | one of two targets inside a wrapper that owns the fill |

Two rules produce that table, and neither is a preference:

- **A full-bleed row draws no radius.** An inset rounded fill inside a padded
  surface reads as a card nested in a card, and every other row list in the
  system fills to its own inset instead (see [menu](../menu/component.md), which
  makes the same call for the same reason).
- **A full-bleed row takes the ring INWARD.** The row touches its container's
  edge, so an outset ring at `focus.ring-offset` is clipped by it. This is the
  carve-out `principles.md` already names for a control that clips its own
  overflow.

## States

| State | Treatment |
|---|---|
| Rest | Transparent (or the dashed edge), `text.default` ink |
| Hover | `bg.hover` ground, ink lifts to `text.primary`. `--flush` lifts the ink only — the wrapper paints the ground |
| Selected | `bg.selected` fill, ink at `text.primary`, and a **2px inset `accent.primary` edge**. Hover is **not applied** while selected |
| Focus-visible | The shared ring; inset at `--bleed` and `--flush` |
| Disabled | 45% opacity, `not-allowed`, hover suppressed |
| Unavailable | `aria-disabled` rather than `disabled`, same look, tab stop kept — for a row whose tooltip explains why it is off |

**Why hover is excluded from a selected row rather than repainted over it.**
`bg.hover` sits *below* `bg.selected` on the surface ramp. A selected row that
also took the hover step would go *darker* under the pointer in light mode and
*lighter* in dark — either way it reads as the row letting go of the choice.
Repainting it (`hover:bg-selected` next to `hover:bg-hover`) is two declarations
of one property at equal specificity, which is settled by stylesheet order; the
fix is that a selected row never receives the hover step at all.

## Usage

- **The create affordance is `--dashed`, full width, at the very top.** Never
  below the scroll, and never a second full-width control stacked above the
  search field (`principles.md` → Composition, The list surface).
- **One `--selected` row on screen per pane.** In a rail → list → detail layout
  the other two panes drop to the resting tier, which the consuming app reaches
  through its `data-selection-pane` cascade rather than a second modifier here.
- Do not add a hover shadow, a scale, or a border that appears. A row that
  changes size under the pointer moves every row after it.

## Accessibility

- **Selection announces as `aria-current`, not `aria-pressed`.** A list row is
  navigation — "this is the one you are looking at" — where a toggle is a switch
  you threw. The app rail's squares deliberately read the other way
  (`aria-pressed` for a tool whose surface is floating), and one row of a drawer
  disagreeing with the row above it is the defect that distinction prevents.
- A row inside a listbox takes `role="option"` and `aria-selected`; the
  component passes both through untouched rather than inferring them.
- The row forwards its `ref`, its `data-*` attributes, `tabIndex`, `role` and
  `onContextMenu`, because a rail drives roving focus by querying for its own
  hook and a group decides for itself where the tab stop is. A row primitive
  that swallowed those is why forty of these stayed raw elements.
- Anything the row reveals on hover must also appear on keyboard focus.

## Shipped implementation

`src/renderer/src/components/ui/RowButton.tsx`, exporting `RowButton` with
`density`, `variant` and `selected`.
