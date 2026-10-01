# Tour strip

The band a diff tour plays under: the tour's name, where you are in it, and the
few controls that act on the tour and nothing else. Shipped as `TourStrip`
(`src/renderer/src/components/ui/TourStrip.tsx`), with its two disclosures —
the step list (`TourStepList`) and the card a tour waits behind until it is
started (`TourReadyCard`, `ui/TourStepList.tsx`).

A diff tour is an agent walking the owner through the changes it made, one
step at a time, inside the Diff viewer. The strip is the tour's chrome; what
the agent says about each step is the [tour callout](../tour-callout/component.md).

## Anatomy

| Part | Class | Required |
|---|---|---|
| Root | `.ds-tour-strip` | yes — `size.control.lg` tall, `bg.surface`, `space.lg` inline padding |
| Mark | `.ds-tour-strip-mark` | yes — the `tour` glyph at `icon.size.sm`, `text.subtle`, `aria-hidden` |
| Title | `.ds-tour-strip-title` | yes — `font.size.body`, `font.weight.medium`, `tracking.tight`, `text.primary`, truncates |
| Position | [pager](../pager/component.md) `--inline` | yes — "3/7 steps" between two chevrons; the sentence "Step 3 of 7" is its polite live name |
| Pointer | [chip button](../chip-button/component.md) | no — "Agent points to step 4 →", only while the agent points somewhere Follow did not take you |
| Play | [button](../button/component.md) `--icon`, pressed | yes — `play` / `pause` glyph; `aria-pressed` while playing |
| Follow | [switch](../switch/component.md) + label | yes — "Follow agent", `font.size.meta`, `text.muted` |
| Divider | the [toolbar](../toolbar/component.md) divider | yes — between the tour's controls and the view's |
| Steps | button `--icon`, pressed | yes — the `step-list` glyph; pressed while the list shows |
| Leave | close button | yes — "Leave the tour" |
| Progress | `.ds-tour-strip-progress` | yes — the band's bottom edge, one segment per step |

The progress edge is the band's only rule. It is 2px, where a plain hairline
would sit, because it carries a position and a hairline carries none: one
segment per step, `border.subtle` ahead, `text.subtle` visited, `text.primary`
for the current step, a 1px gap between. Neutral ink throughout — the accent
is the Start button's and the step's gutter hairline's, and a moved or gone
step is said by the step list in glyphs and words, never by a hue on this edge.

### Step list (disclosure)

A column on the diff's leading edge, `15rem` wide, `bg.surface`, with a 1px
`border.subtle` between it and the diff. One [row button](../row-button/component.md)
`--bleed` per step: the step number in `font.family.mono`, `tabular-nums`,
right-aligned in a 20px slot; the title; the file's name in mono at
`font.size.micro`; and one trailing mark — a tick for visited, the warning
triangle in `status.warn` for moved, a short dash for gone. The current step
takes the neutral selection fill. A step's `hoverTip` is its row's tooltip.

### Ready card (disclosure)

Before Start the strip is not drawn: a card stands where the diff will play,
on `bg.app`, centred, `max-width: 28rem`. `bg.surface-raised`, a 1px
`border.default` edge, `radius.shell`, `space.2xl` padding, no shadow. From the
top: the `tour` glyph and "Tour ready" in `text.muted` meta; the title at
`font.size.title`; one meta line ("7 steps · 3 files · by <agent>"); the
agent's overview, if any, as compact markdown; then **Start** — the
[button](../button/component.md) `--primary` at `size.control.md`, the one
accented action in the view — and a ghost "Not now". A tour that was played
before offers "Resume at step N" in Start's place.

## Variants

None. There is one tour strip. What it shows changes with the tour — the
pointer chip exists only while the agent is pointing somewhere else.

## States

| State | Treatment |
|---|---|
| Ready | No strip: the ready card stands in the body |
| Playing | The strip, the pager on the current step, Play at rest |
| Auto-advancing | Play pressed (`pause` glyph); holds while the pointer is over the callout or its field has focus |
| Follow on | Switch on. The agent's `tour.goto` moves the view; the pointer chip never shows |
| Follow off, agent pointing | The pointer chip, until the step it names has been visited |
| Step list open | Steps pressed; the list stands on the leading edge |

## Usage

- It takes the **commit step strip's slot** above the diff toolbar while a tour
  plays, so the region keeps one band above its own toolbar, not two. Leaving
  the tour gives the slot back.
- The strip holds more than the pane-chrome ceiling of five because every
  control on it acts on the tour and nothing else — the band is the tour's own
  header (`principles.md` → the five-controls amendment), grouped by the
  divider into "where in the tour" and "how the tour is shown".
- **Nothing plays until Start.** An agent finishing a tour docks the Diff tab
  without selecting it; the tab wears the corner count and the owner opens it
  when they choose. The strip never appears on its own.
- `]` and `[` step while focus is in the diff (the editor, the strip, the list)
  and nowhere else. They never replace F7, ⇧F7, ⌘↑ or ⌘↓.

## Accessibility

- The pager's sentence ("Step 3 of 7") is its polite live name, so each step is
  announced once — the callout does not announce itself as well.
- Play is a toggle and says so (`aria-pressed`); its name changes with it
  ("Play tour" / "Pause tour").
- The step list is a `nav` named "Tour steps" holding an ordered list; each
  row's accessible name carries its state in words ("visited", "code has
  changed", "file no longer in the diff"), because the trailing mark is
  `aria-hidden`.
- The ready card is a named `section`; Start takes no focus on arrival. Nothing
  about a tour moves focus: it is reached by Tab like anything else.
- Under `prefers-reduced-motion: reduce` nothing on the strip animates, and
  Play still advances — it is a timer, not a motion.
