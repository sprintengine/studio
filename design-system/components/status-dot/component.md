# Status dot

The product's one dot: 6px, a tone from the status ramp, and — while
something is genuinely running — a pulse. Extracted from the shipped
`StatusDot` primitive (`src/renderer/src/components/ui/StatusDot.tsx`).

This is the smaller of the system's two status idioms; the other is the
lifecycle glyph. A surface uses one or the other, never both — a dot beside
a tinted pill saying the same thing is the reject-on-sight the principles
name. Use the dot for live state (connected, degraded, failing); use a
lifecycle glyph when the state is a worklist stage that must read by shape.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Dot | `.ds-status-dot` | yes — a 6px disc, `status.neutral` by default |

One part. There is no label part, no ring, no badge shell — the dot sits
beside text that names the state, or carries an accessible name itself.

## Variants

- **Default** — `status.neutral`. A known, unremarkable state worth marking.
- **`--good`** — `status.good`. Passing, connected, healthy-but-notable.
- **`--warn`** — `status.warn`. Degraded, needs attention soon.
- **`--danger`** — `status.danger`. Failing, needs attention now.
- **`--merged`** — `status.merged`. A landed change; a status a dot carries,
  never an emphasis a control asks for.
- **`--accent`** — `accent.primary`. Identity, not status: "this is the live
  one". Spend it against the accent budget like any other accent ink.

There is no size variant. 6px is the idiom; a bigger dot is a different
component pretending.

## States

| State | Treatment |
|---|---|
| Rest | The tone fill, nothing else |
| Live | `--pulse` — a slow opacity/scale breath while a process is actually running |

The pulse is the *alive right now* motion — one of the two things motion is
allowed to mean. Its 1800ms cycle is deliberately off the interaction
ramp: those durations pace responses to input; this paces a breathing state.

## Usage

**No dot is the default.** Healthy, done, and idle render no mark at all.
The dot marks the exceptions — which is the only reason a glance down a list
finds them. A dot on every row is a bullet point.

**Shape first, color second — so the dot never stands alone.** A 6px disc
has no shape channel: every tone is the same circle, and the states are
indistinguishable in grayscale. The dot therefore always accompanies text
that states the state, or a surface whose accessible name does. It is an
attention mark, not the message.

**Never category color.** Tones are the status ramp only. Coloring dots by
project, provider, or type turns the status channel into a legend nobody
memorizes — identity belongs to labels and glyphs.

**Pulse sparingly.** At most one thing animates at a time. One pulsing dot
means "this one is running"; a column of them is ambient noise, which is not
motion the system allows.

## Accessibility

- Beside text that already states the state, the dot is decorative:
  `aria-hidden="true"`. This is the common case.
- Standing for a state no adjacent text names, it carries `role="img"` and
  an `aria-label` naming the state ("Degraded") — never the color ("amber").
- Never both: a labelled dot next to the same words is announced twice.
- The pulse honors `prefers-reduced-motion: reduce` — the animation stops,
  the tone stays, and the running state remains stated by the accessible
  name or the adjacent label. Motion is never the sole signal.
