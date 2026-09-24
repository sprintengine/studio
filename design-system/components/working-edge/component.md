# Working edge

A light that travels round the edge of a surface while that surface is being
brought back, with its content still on screen and still readable. Shipped as
`WorkingEdge` (`src/renderer/src/components/ui/WorkingEdge.tsx`). Its first
use is a paused agent terminal resuming: the frozen output stays up, readable
and scrollable, until the relaunched agent's first frame replaces it, and the
edge is what says the click was heard.

It is a [liveness](../liveness/component.md) mark: it means *alive right now*.
What sets it apart from the spinner and the working dots is where it sits. Both
of those are marks placed beside something; the working edge belongs to a whole
surface, and it is the one liveness mark that can run while the content it
concerns is fully visible, because it paints on the edge and never over the
content.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Edge | `.ds-working-edge` | yes. An empty element, last child of a positioned surface; it fills that surface's box and follows its radius |
| Status | `role="status"`, visually hidden | yes. One short phrase ("Resuming agent") |

The edge is a 2px ring: the element's border box with its padding box masked
out. It is a faint `accent.soft` track all the way round with an
`accent.primary` head that fades into the track behind it, and the head laps
the ring once every 1800ms. Everything inside the ring is left alone.

On a surface that wears a focus ring, the edge runs on the ring's own line
(same inset, same radius) and stands in for it while it runs: an accent head
travelling over a solid accent ring is the same colour on the same pixels, so
it would not be seen. When the edge goes, the ring is back.

## Variants

None. One surface, one edge, one colour. A second hue for "resuming with
problems" would be status by colour alone; a problem is reported as a problem,
by the surface or a notice, when it happens.

## States

| State | Treatment |
|---|---|
| Absent | Not rendered. The surface at rest carries no edge at all |
| Working | The light laps the edge; it fades in on `motion.duration.normal` |
| Reduced motion | A still `accent.soft` ring. No lap, no fade |
| Done | Removed the moment the work lands, with no exit choreography; what replaced the old content is the signal |

## Usage

- Use it for a bounded wait on a surface whose content stays useful during the
  wait: a terminal resuming, a document reconnecting. The content is the reason
  it exists. A surface with nothing to show yet takes a
  [skeleton](../skeleton/component.md) or the loading overlay
  ([spinner](../spinner/component.md)) instead.
- One per surface, and never together with a spinner or a skeleton on the same
  surface. One loading idiom per region.
- Never ambient. It appears because the person asked for something (a click, a
  keystroke) and it leaves when that has happened. An edge that is always
  running stops meaning anything.
- It takes no pointer events. The surface under it stays scrollable and
  selectable, and a click there must still reach the surface.
- The edge sits on `z.float`, over its own surface's content and inside its
  pane, and it portals nowhere.

## Accessibility

- The edge is `aria-hidden`. The fact is carried by one visually hidden
  `role="status"` phrase, polite, rendered with the edge and removed with it.
- Motion is never the only signal: under `prefers-reduced-motion: reduce` the
  ring is still there, just still.
- It takes no focus and changes nothing about focus. Whatever had the keyboard
  keeps it, which on a terminal is what lets the keys typed during a resume
  reach the resumed agent.
