# Liveness

The two things motion is allowed to mean, and the marks that mean them.

Motion in this system says exactly one of two things: **something is alive right
now**, or **something just changed**. Anything else — an entrance flourish, a
hover lift, a decorative loop — is noise competing with the two signals that
carry information, and it teaches people to ignore movement.

| Mark | Means | Shipped as |
|---|---|---|
| Working dots | alive right now, for an unknown duration | `ui/AgentWorkingDots.tsx` |
| Change pulse | just changed, one shot | `ui/ChangePulse.tsx` |
| Spinner | alive right now, for a bounded wait | [spinner](../spinner/component.md) |

## Working dots

Three staggered dots in `accent.primary`, ~14px wide, on a pure-CSS keyframe
loop. Use it where work is genuinely in flight and has no predictable end — an
agent running, a job with no progress to report.

It is **not** a spinner substitute. A spinner says "wait, this will finish";
the dots say "this is ongoing", which is why they live on a row that stays
readable and interactive around them rather than over a blocked surface.

Never ambient. A mark that is always moving stops meaning anything, and it is
the single most effective way to make a list feel unquiet.

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
| Rest | no motion at all — both marks are absent or static |
| Live | dots cycle; the surface around them stays interactive |
| Changed | one pulse, then rest — never a repeat, never a loop |
| Reduced motion | dots collapse to a single static accent dot; the pulse does not play |

Reduced motion is handled in the stylesheet rather than in each component, so a
consumer cannot forget it: the same class that animates is the class that
carries the `prefers-reduced-motion` guard.

## Accessibility

- The working dots are `role="img"` with a **required** label — "Agent working"
  is information, and a purely visual liveness cue is invisible to a screen
  reader.
- The change pulse is **decorative only** and takes no ARIA. Whatever changed is
  announced by the thing that actually changed — the badge count, the status
  line — not by the animation.
- Neither mark may be the only carrier of its meaning. Someone with reduced
  motion, or not looking at that corner of the screen when it fired, must still
  be able to find out.

## Usage

- One liveness mark per row. Dots *and* a spinner *and* a pulsing badge on the
  same row is three components saying one thing.
- Never pulse on a value the person just typed. The pulse means "this changed
  underneath you"; replaying their own edit back at them is noise.
- Motion is not emphasis. Something important but static gets ink, weight or a
  tone — never movement.
