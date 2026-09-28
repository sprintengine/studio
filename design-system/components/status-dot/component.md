# Status mark

What the `StatusDot` primitive draws
(`src/renderer/src/components/ui/StatusDot.tsx`). The name is historical: the
component is kept under it because modules import it through the SDK. **The
product draws no status dots** (owner ruling 2026-09-28). A 6px disc has no
shape channel, so every tone was the same circle, "working" and "waiting"
looked alike, and a tab could show a dot while the row beside it showed the
working dots for the same fact.

A status is drawn as one of two things:

- **Live work** (a good or accent tone, pulsing) is the **working dots**
  (`AgentWorkingDots`): three staggered accent dots. This is the only
  "working right now" mark, and the sidebar row, the tabs and the peek card all
  use it.
- **Every other state** is a **lifecycle glyph** in the tone's ink: the same
  shape-coded vocabulary as the worklists and the notifications.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Mark | `.ds-status-dot` | yes. A 13px (`icon.size.xs`) glyph, drawn as a mask in the tone's ink |

There is still one part only: no label part, no badge shell. The mark sits
beside text that names the state, or it carries an accessible name itself.

## Variants

| Tone | Shape | Reads as |
|---|---|---|
| Default (neutral) | Ring with a bar | Off, held, disabled |
| `--good` | Disc with a knocked-out check | Passing, connected, enabled |
| `--warn` | Ring with "!" | Degraded; needs attention or input soon |
| `--danger` | Ring with "×" | Failing; needs attention now |
| `--merged` | Disc with a knocked-out check, merged ink | A landed change |
| `--accent` | Quarter arc | Identity, not status: "this is the live one" |
| `--working` | Three dots | Something is running right now |

Every tone has its own shape, so the states still read in grayscale. The
colour only reinforces the shape.

## States

| State | Treatment |
|---|---|
| Rest | The tone's glyph, nothing else |
| Live, working | `--working`. The three dots rise in turn |
| Live, waiting | `--pulse` on a warn or danger glyph. A slow breath while it waits on someone (a pairing request, a recording) |

The breath's 1800ms cycle is deliberately off the interaction ramp: those
durations pace responses to input, and this one paces a breathing state.

## Usage

**No mark is the default.** Healthy, done and idle rows render nothing. The
mark is for the exceptions, which is the only reason a glance down a list finds
them. A mark on every row turns into a column of bullet points.

**Never a dot.** Not a hand-rolled `rounded-full` span, not a tone-filled disc
docked on a corner, not a text bullet. A surface that wants to say a state uses
this component. A "filters applied" trigger says so with its accent tint and
its accessible name, not with a dot.

**Never category colour.** Tones come from the status ramp only. Identity
belongs to labels and brand marks.

**Animate sparingly.** At most one thing animates at a time. One set of working
dots means "this one is running"; a column of them is noise.

## Accessibility

- Beside text that already states the state, the mark is decorative:
  `aria-hidden="true"`. This is the common case.
- Standing for a state no adjacent text names, it carries `role="img"` and an
  `aria-label` naming the state ("Degraded"), never the colour.
- Never both: a labelled mark next to the same words is announced twice.
- Reduced motion stills the working dots (all three stay, so the mark never
  becomes a dot) and stops the breath. The shape and the accessible name keep
  carrying the state.
