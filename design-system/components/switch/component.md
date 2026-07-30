# Switch

A setting that takes effect the moment it is thrown. There is no Save, no
confirmation, and no third value: the control *is* the state, and the state is
boolean.

Use a checkbox when the value is one entry in a set the person submits later,
and a segmented control when there are three or more choices. A switch that
needs an explainer sentence under it is the wrong control, or the wrong label.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Track | `.ds-switch` | yes — `role="switch"`, `aria-checked`, and a name from `aria-label` or `aria-labelledby` |
| Thumb | `.ds-switch-thumb` | yes — `aria-hidden`, purely the position indicator |

The track is 32x18 with a 12px thumb inset 2px from whichever end it rests
against. 18px is 6px under `size.hit-target-min`, and the control does not pad
out to it: the geometry is fixed by the owner ruling this size came from, and
padding the button would inflate the track it draws. This is the one sanctioned
exception in the system, and it is a real one — a near-miss above or below a
switch lands on whatever the host row does with a click. A host that puts a
switch in a row with its own click behaviour owes the switch clearance.

The off-state hairline is an inset shadow rather than a border. A border would
take 1px out of the box on the off state only — the thumb would then sit 1px
further in when off than when on — and it would pop in and out on toggle
instead of crossfading. As a shadow it is free of layout, and it composes with
the focus outline rather than replacing it.

There is no label part. The name is the consumer's own text, pointed at with
`aria-labelledby`, or an `aria-label` when the control is genuinely alone.

## Variants

None. One size, one shape, one accent.

A small variant is a rejected idea: the control is already at the floor of what
reads in a dense row. A tone variant is also rejected — the fill is the one
accent, and a red or amber switch would be a state a person must act on, which
belongs in a notice rather than in a setting.

## States

| State | Treatment |
|---|---|
| Off | `bg.active` fill, `border.default` hairline, thumb in `text.primary` at the leading end |
| On | `accent.primary` fill, hairline faded to transparent, thumb in `text.on-accent` at the trailing end |
| Pressed | Thumb stretches to 15px, anchored at the end it is resting against |
| Focus | the shared `focus.ring` outline at `focus.ring-offset`, from `:focus-visible` only |
| Disabled | 45% opacity, `not-allowed` cursor, no press stretch |

The thumb's ink follows the surface under it: `text.on-accent` on the accent
fill, `text.primary` on the neutral one. A statically light thumb vanishes on
any theme whose accent is itself bright.

Focus takes the shared treatment with no local override — and this control is
why that treatment is an offset outline. `border.focus` and `accent.primary` are
the same value, so the zero-offset ring `focus.ring` used to be landed directly
against a checked track of its own colour and focused became indistinguishable
from unfocused. Every accent-filled control collided the same way, so the offset
moved into `focus.ring` itself rather than staying an exception here.

Travel runs at `motion.duration.normal` on the standard ease — slow enough to
be read as movement rather than a jump. The fill, the hairline, and the thumb's
ink all crossfade at `fast`, so the colour has settled by the time the thumb
lands. The press stretch is one detail, not a spring: 3px, anchored, gone on
release.

## Usage

**It commits immediately.** Never pair a switch with a Save button, and never
put one in a form that submits later — that is a checkbox. If the write can
fail, the row owns the failure: show the error next to the control and put the
switch back where it was.

**Label the setting, not the state.** "Notify on failure", not "Notifications
are on" — the control already says which way it is thrown, and a label that
restates it goes stale the moment it is toggled.

**No caption under it.** A switch whose meaning needs a sentence is a naming
problem. Rewrite the label.

**Disabled means unavailable, not forbidden.** Disable only when the setting
genuinely cannot apply — its dependency is missing, the workspace has no such
capability. When a person merely lacks permission, say so where the row can be
read rather than presenting a dead control.

**One per row.** Two switches on the same row are two settings sharing one
label, and neither is named.

**Rebuilding it in a framework:** it is a `<button>`, never an
`<input type="checkbox">` with the box hidden. The checkbox carries the wrong
role and the wrong keyboard contract, and its native focus outline lands on a
box nobody can see. Keep the thumb a real element rather than a `::after`, so
the framework can key its position off the same `aria-checked` the
accessibility tree reads.

## Accessibility

- `role="switch"` with `aria-checked` reflecting the live value. Not
  `aria-pressed` — that is a toggle button, which is a different announcement.
- **Space toggles, Enter does not.** This is the ARIA switch contract, and it
  is the one place a switch diverges from an ordinary button: swallow Enter
  rather than letting it fall through to a click.
- A name is mandatory — `aria-labelledby` pointing at the visible setting name
  where there is one, `aria-label` only when the control stands alone. A switch
  with no name announces as "switch, on" and names nothing.
- `:focus-visible`, never `:focus`, so clicking one does not leave a ring
  behind on a control the pointer already answered.
- The disabled state uses the `disabled` attribute, so the control leaves the
  tab order rather than sitting in it as an unusable stop.
- State is never carried by the fill alone: the thumb's position says the same
  thing, which is what keeps the control readable when the accent and the
  neutral fill are close in value.
- Every transition and the press stretch sit behind
  `prefers-reduced-motion: reduce`. Position, colour, and contrast are
  identical with motion off — nothing about the state is disclosed by the
  animation itself.
