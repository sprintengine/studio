# Liveness

The marks that say something is happening, and the one that says something just
changed.

Motion here carries information first: **something is alive right now**, or
**something just changed**. It is also allowed a little character (ruling
2026-09-28): a working mark picks one of four patterns so a list of working
chats does not tick in step, and a spawned agent is drawn as a small
[agent glyph](../agent-glyph/component.md) that moves while it works. What motion
never does is decorate something at rest. A mark that moves while nothing is
happening teaches people to ignore movement.

| Mark | Means | Shipped as |
|---|---|---|
| Working mark | alive right now, for an unknown duration | `ui/WorkingMark.tsx` |
| Agent glyph | this spawned agent is working, or how it ended | [agent-glyph](../agent-glyph/component.md) |
| Change pulse | just changed, one shot | `ui/ChangePulse.tsx` |
| Spinner | alive right now, for a bounded wait | [spinner](../spinner/component.md) |
| Working edge | alive right now, on a surface whose content stays readable meanwhile | [working-edge](../working-edge/component.md) |

## Working mark

A 3×3 grid of small square cells in `accent.primary`, 14px across, every cell
resting dim. One of four patterns lights them, on a pure-CSS keyframe loop:

| Pattern | Movement |
|---|---|
| Orbit | a lit cell runs round the edge, trailing a fading tail; the centre holds still |
| Ripple | a diagonal wave washes across, corner to corner |
| Think | cells light in a shuffled order, like it is working something out |
| Snake | a three-cell snake slithers round the edge; the centre holds still |

The pattern is picked from a seed, the id of the chat or agent that is working,
so a chat keeps its pattern for as long as it works and a row of working chats
spreads across all four. Use the mark where work is genuinely in flight and has
no predictable end: an agent running, a job with no progress to report.

It is **not** a spinner substitute. A spinner says "wait, this will finish"; the
mark says "this is ongoing", which is why it lives on a row that stays readable
and interactive around it rather than over a blocked surface.

## Change pulse

A one-shot tint-and-glow that eases back to rest when a watched number moves.
It paints in the **status colour that already applies** — passed in as a tint —
so it never introduces a new accent, and it never fires on first render, only on
a change from a value that was already on screen.

Wrap the icon, not the number. The pulse is decoration; the real count stays on
a sibling [badge](../badge/component.md) or in the control's accessible name, so
nothing depends on having seen the animation.

## States

| State | Treatment |
|---|---|
| Rest | no motion at all: the mark is absent, the pulse static |
| Live | the mark's pattern cycles; the surface around it stays interactive |
| Changed | one pulse, then rest — never a repeat, never a loop |
| Reduced motion | every working mark holds one still frame, the four corners and the centre lit; the pulse does not play |

Reduced motion is handled in the stylesheet rather than in each component, so a
consumer cannot forget it: the same class that animates is the class that
carries the `prefers-reduced-motion` guard. The still frame is the same for all
four patterns, so "working" reads one way to someone who has turned motion off.
It is never a dot.

Every loop also holds still while the window is hidden or in the background,
and a transcript row pauses its own when it scrolls out of view.

## Accessibility

- The working mark is `role="img"` with a **required** label — "Agent working"
  is information, and a purely visual liveness cue is invisible to a screen
  reader.
- The change pulse is **decorative only** and takes no ARIA. Whatever changed is
  announced by the thing that actually changed — the badge count, the status
  line — not by the animation.
- No mark may be the only carrier of its meaning. Someone with reduced motion,
  or not looking at that corner of the screen when it fired, must still be able
  to find out.

## Usage

- One liveness mark per row. A working mark *and* a spinner *and* a pulsing
  badge on the same row is three components saying one thing.
- Seed the mark with the id of what is working, never with something that
  changes while it works, or the pattern will jump.
- Never pulse on a value the person just typed. The pulse means "this changed
  underneath you"; replaying their own edit back at them is noise.
- Motion is not emphasis. Something important but static gets ink, weight or a
  tone — never movement.
- Never a status dot. State is a word, a glyph, a timer, a working mark or an
  agent glyph (ruling 2026-09-28).
