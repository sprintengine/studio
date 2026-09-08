# Workspace panel

The full-height content surface: one [panel header](../panel-header/component.md)
band, an optional category rail, and a scrolling body whose text is capped to a
reading measure and centred. It is what a settings surface, a wizard step or a
managed list is built *inside* — the frame, not the content. Extracted from the
shipped `WorkspacePanel` primitive
(`src/renderer/src/components/ui/WorkspacePanel.tsx`).

It is not a [modal](../modal/component.md) and not a
[drawer](../drawer/component.md): it draws no scrim, casts no shadow, traps no
focus, and takes no layer. It fills whatever region it is given. Whether the
region floats is the host's question; this component's answer is the same
either way, which is what lets one surface be a door in one place and the body
of a dialog in another.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Panel | `.ds-workspace-panel` | yes — a `<section>` named by its header, `bg.app`, full height, flex column |
| Header | `.ds-panel-header` | yes — the panel-header band, unchanged; the close affordance is its primary action |
| Body | `.ds-workspace-panel-body` | yes — the row (or column) holding the rail and the scroller |
| Rail | `.ds-workspace-panel-rail` | no — an `<aside>` of categories, `bg.surface-raised`, one hairline against the scroller |
| Scroller | `.ds-workspace-panel-scroll` | yes — the one scroll container; the header never scrolls with it |
| Measure | `.ds-workspace-panel-measure` | yes — the capped, centred column the content sits in |

**One band of chrome, and it is the shared one.** The panel does not draw its
own title row: it composes `panel-header`, which is what makes "one header" true
of the kit rather than only of the kit's consumers. Before that it drew a
private band at a different height with a `font.size.title` heading, so a panel
that named itself through this component started its content on a different line
from every panel that named itself through the primitive.

**The measure is centred, because it IS the page.** A capped column that is the
content of its region centres (`margin-inline: auto`); its inset is `space.xl`
inline and `space.2xl` block. The 760px cap is a reading measure, not a token —
the same class of value as the side pane's rails.

**The rail is a column of categories, never a list of things.** It is
`space.xs` of padding around rows the consumer supplies, 192px wide at panel
width, and it stacks *above* the body on a narrow window rather than shrinking:
a rail thinner than its longest label is a rail nobody can read.

## Variants

- **Without a rail** (default) — the body is a single scrolling column. Most
  panels are this.
- **`--railed`** — the rail is present. The hairline moves with the layout: a
  bottom border while stacked, an inline-end border once the two sit side by
  side. One hairline either way, never both.
- **Closable / not** — the close affordance is the header's primary action, and
  it is the kit's canonical close (`CloseIconButton`) at the `md` control step.
  A panel with no `onClose` renders no actions slot at all rather than a
  disabled button: a surface the person cannot dismiss should not show them a
  dead target.
- **The content's own inset is replaceable.** A consumer that needs full-bleed
  content — a table that runs to the panel's edges, an editor — replaces the
  measure rather than fighting it. What it must not do is keep the measure and
  add a second inset inside it.

## States

| State | Treatment |
|---|---|
| Rest | `bg.app` ground under a `bg.surface` header band; the rail one tone step up at `bg.surface-raised` |
| Mounted | The panel takes focus once, on the section itself (`tabindex="-1"`), so the keyboard starts inside the surface rather than wherever it was |
| Mounted without focus | Opt-out for a panel mounting behind something else — focus stays where the person left it |
| Scrolled | Only the scroller moves. The header band and the rail stay put |
| Narrow | The rail unstacks above the body; the measure keeps its inset and gives up its cap |

The panel has no hover, selected or disabled state. It is a frame; every state
belongs to something inside it.

## Usage

**One panel, one subject.** The header names it, and the body is about that
one thing. A panel hosting two unrelated subjects is two panels, or a rail with
two categories.

**Never stack a band under the header.** A status sentence, a tools row or a
tab strip between the header and the scroller is the two-bands-of-chrome defect
the principles reject on sight. Controls belong in the header's actions slot;
status belongs to the row that has it; a notice about the content is not chrome
and keeps its own band inside the scroller.

**The rail names categories, not items.** It is the second level of an area,
not a list a person walks — that is a list surface
(`patterns/list-surface`), and it belongs in the region's own column.

**Do not re-implement the frame.** A surface that draws its own title row, its
own close button and its own capped column is three private decisions the kit
already made. The reason this component exists at all is that those three had
been made twice.

**Rebuilding it in a framework:** what must survive is the composed header (not
a second header anatomy), the single scroll container, the centred capped
measure, the one-hairline rail that stacks rather than shrinks, and the section
being focusable and named by its own heading.

## Accessibility

- The panel is a `<section>` with `aria-labelledby` pointing at the header's
  `<h2>`, so it lands in the document outline as a named region rather than as
  an anonymous div. The consumer may supply the id; the component supplies a
  stable one otherwise.
- The section carries `tabindex="-1"` and takes focus on mount so a keyboard
  user starts inside the surface. It is a programmatic focus target only — it
  never enters the tab order, and it shows no focus ring, because focus landing
  there is the component's doing rather than the person's.
- The close affordance is an icon-only button and carries an `aria-label`; the
  label is the consumer's, so a panel that closes something more specific than
  itself can say so.
- The rail is an `<aside>` and its rows carry their own semantics — the frame
  does not pre-empt them. A rail of navigation rows marks the current one with
  `aria-current`.
- Scrolling is the scroller's, so a screen reader's virtual cursor and the
  visible scroll agree; a nested second scroll container inside the measure is
  a bug.

## Known drift

- **The header still accepts a subtitle here.** `WorkspacePanel` forwards a
  `subtitle` to `PanelHeader`, and the panel-header entry rules that band to
  "no status chips, no counts line, no subtitle sentence" — a scope word is the
  ceiling. Every consumer passing prose in that slot is a redesign signal, and
  the prop should narrow to the header's `scope` shape.
- The 192px rail width and the 760px measure are computed layout values with no
  comment in the source saying what they line up with. They are legitimate
  measures rather than missing tokens, but the principles ask an off-scale
  measure to say what it is for.

## Shipped implementation

`src/renderer/src/components/ui/WorkspacePanel.tsx`, exporting `WorkspacePanel`
and a `WorkspacePanelHandle` ref that exposes `focus()` so a host can return the
keyboard to the surface. It composes `ui/PanelHeader` and
`ui/Buttons`' `CloseIconButton`, and is outside the kit barrel.
