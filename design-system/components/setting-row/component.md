# Setting row

The state-a-value-and-change-it row: one setting, said in a label and at most
two lines of help, with the control that changes it on the right. A settings
page is nothing but these.

It is **not** a list row. [list-row](../list-row/component.md) is the
pick-an-item row — the person chooses it, it becomes selected, and the detail
pane answers. Nothing here is selectable and nothing here is chosen: the row is
a label for a control, and the only interactive thing in it is that control.
So this row has no hover fill, no selected state, and no cursor — three
channels it would otherwise have to keep apart for no reason.

Use [check-row](../check-row/component.md) when the row's own value is a tick
and the rows are a list the person is marking up. Use
[provider-row](../provider-row/component.md) for a connected service with a
status and a connect action. Use this for a setting.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Card | `.ds-setting-row-list` | yes — the surface a run of rows sits in |
| Row | `.ds-setting-row` | yes — a `<div>`; the row is never a control |
| Text block | `.ds-setting-row-text` | yes — claims the width, gives it up first |
| Label | `.ds-setting-row-label` | yes — a `<label>` when one control owns the row |
| Requirement | `.ds-setting-row-requirement` | no — a muted suffix on the label line naming an unmet prerequisite |
| Help | `.ds-setting-row-help` | no — one or two lines, wraps, never truncates |
| Control host | `.ds-setting-row-control` | yes — the control that changes the value |

**The card is part of the component, not a wrapper someone remembers to add.**
A run of setting rows is always in one, and the rows are drawn to be full-bleed
inside it: square corners, hairlines between rows only, the card's radius doing
the clipping. Rows loose on a page is the shape this component replaced.

### The section label sits outside the card

A group of settings is a [section](../section/component.md) title above a card,
not a title inside one. The card is the group's edge; a heading inside it would
draw a second one. So the page reads: label, card, gap, label, card.

The label keeps the section component's own typography — this component does
not restyle it. What changes is that the label no longer has to carry the
separation on its own, which is the whole point: the card holds the group, and
the heading goes back to only naming it.

This is the "stated reason" the section spec asks for before content takes a
container. Recorded in `foundations/principles.md` under *Hairlines carry the
structure* (ruling 2026-09-14).

## Variants

- **Default** — label and help on the left, control on the right, vertically
  centred.
- **`--stacked`** — the control drops under the text, for a control that needs
  the full width: a path field, a four-option segmented control, a text area.
  The row keeps its padding and its hairline; only the axis changes. Reach for
  it per row, not per card — a card of stacked rows is a form, and a form wants
  [field](../field/component.md).
- **`--disabled`** — the control cannot be used yet. The label drops to
  `text.muted`; the help stays as it is, because a person has to be able to
  read what they cannot have. Pair it with a `--requirement` suffix saying why.
  The **control host does not dim** — every control here draws its own disabled
  treatment, and a second opacity on the host multiplies with it (a switch at
  0.45 inside a host at 0.5 lands near a fifth). The control owns its own
  disabled tone; the row owns the label and the reason.

## States

The row has none. It is a label and a container — every state belongs to the
control inside it, which brings its own hover, focus ring and disabled tone
from its own component.

| Part | Treatment |
|---|---|
| Row | No hover, no focus, no selection. It is not a control |
| Card | No hover, no shadow. `border.subtle` at rest and always |
| Control | Whatever its own component specifies, disabled included |
| Disabled row | Label drops to `text.muted`. The host itself is untouched |

**No shadow, ever.** The card is in the document flow, and elevation in this
system is a three-step overlay ramp for popovers, drawers and modals only
(`principles.md`, *Hairlines carry the structure*). A settings card that lifts
off the page is an overlay that forgot it was content.

## Usage

- **One setting per row.** Two switches on one row is two settings sharing one
  label, and the help line can only describe one of them.
- **Help is one or two lines, and it says what the setting does** — not what
  the control is. "Settle a thread when its pull request merges" earns its
  line; "Toggle this on or off" does not. A row whose help would only restate
  its label ships without help.
- **The control stays sized to its content.** A 240px input, an intrinsic
  select, a switch. A full-width control in the default variant is the
  `--stacked` variant asking to be used.
- **Group by what a person would change together**, and keep a card to a
  readable run — past roughly eight rows the card stops being a group and goes
  back to being a scroll, and the group wants splitting.
- **A card is a group, so a card of one row is not a group.** One row alone
  under its own label belongs in the neighbouring card, or the label goes and
  the row joins the page's first card.
- Do not nest a card in a card. A setting that opens onto more settings is a
  row with a disclosure, or a page of its own.

## Accessibility

- The row is a `<div>` and takes no focus. The control is the only tab stop.
- When one control owns the row, the label is a real `<label>` with `for`
  pointing at it, so the label text is clickable and is read as the control's
  name.
- When the control cannot take a `for` (a switch rendered as a `<button>`, an
  action pair), point the control at the text instead:
  `aria-labelledby` on the label and `aria-describedby` on the help. Never both
  a `<label for>` and an `aria-labelledby` — that is two names for one control.
- The requirement suffix is inside the labelled element, so "Needs Sprint
  Engine" is read as part of the control's name rather than being lost.
- A disabled control uses the `disabled` attribute, or `aria-disabled="true"`
  when it must stay focusable to explain why.
- The card is a plain container with no role. When the rows are genuinely a
  list of like things the card may be a `<ul>` with `<li>` rows; a card of
  unrelated settings is not a list and must not claim to be one.
- Help text is never the only place a constraint appears. A numeric field with
  a floor states it on the control (`min`), not only in prose.
