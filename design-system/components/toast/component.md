# Toast

The transient report. A toast announces the result of something the person
just did — or a failure they must not miss — from the viewport's corner,
without taking focus and without asking anything back. It is the answer to
"did it work?" in one line: a count, a name, a state. Extracted from the
source product's `Toast` primitive (`src/renderer/src/components/ui/`).

A toast never carries a question (that is a modal), never carries the only
route to an action (a surface that must be acted on is a banner or an inline
notice, which stay put), and never dumps the operation's inventory — file
counts, hashes, byte sizes are stored, not displayed.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Region | `.ds-toast-region` | yes — the fixed corner stack at `z.toast`; one per document |
| Surface | `.ds-toast` | yes — `role` and `aria-live` chosen by tone (below) |
| Tone dot | `.ds-toast-dot` | yes — the 6px status idiom, `aria-hidden` |
| Content | `.ds-toast-content` | yes — title `.ds-toast-title`, optional description `.ds-toast-description` |
| Dismiss | `.ds-toast-dismiss` | no — trailing icon button, `aria-label="Dismiss"` |

The surface separates from the page with a `border.default` hairline on
`bg.surface-raised`. **No shadow**: no elevation token names the toast (the
ramp's three steps are popover, drawer, modal), and the shipped toast ships
none — a small surface at the viewport's edge is not anchored to anything a
shadow would lift it from.

The tone is carried by the dot's shape-plus-color and by the words — never by
tinting the surface. A toast that survives greyscale is the test.

## Variants

Five tones, each deciding color, politeness, and persistence:

| Tone | Dot | Role / live | Auto-dismiss |
|---|---|---|---|
| `--neutral` | `status.neutral` | `status` / `polite` | 5 s |
| `--good` | `status.good` | `status` / `polite` | 5 s |
| `--accent` | `accent.primary` | `status` / `polite` | 5 s |
| `--warn` | `status.warn` | `alert` / `assertive` | never |
| `--danger` | `status.danger` | `alert` / `assertive` | never |

**Warn and danger stay until dismissed.** An auto-dismissing error is a
failure the operator can miss by looking away for five seconds; a persistent
success is furniture. The policy is the point — consumers may override the
duration, not the split. (The shipped kit names the danger tone `error`; the
class here follows the token grammar, `status.danger`.)

There is no action-button variant. "Undo" in a toast is an action on a timer,
racing its own surface's dismissal — the undo belongs where the change is
visible.

## States

| State | Treatment |
|---|---|
| Entering | An 8px rise-and-fade at `motion.duration.normal` / `motion.ease.standard` — a *just-changed* motion composing the sanctioned pair, removed under reduced motion |
| Resting | Static; no pulse, no progress ring counting down the dismissal |
| Dismissed | Removed. No exit animation: leaving quietly is the whole job |

## Usage

**One region, one corner.** All toasts stack in a single `.ds-toast-region`
— bottom-trailing, newest at the bottom, `space.sm` apart. Two corners
announcing at once is two voices; route every producer through the one
region.

**Report the result, not the inventory.** "Sprint archived" — not the branch,
the commit count, and the layout the archiver chose. The description line is
for the one fact the person cannot see from where they are (where a file was
written, which workspace adopted the change).

**A toast is not the state.** Whatever it announces must also be readable
somewhere persistent — the row's status, the detail pane. A person who missed
the toast lost nothing they cannot find.

**The dismiss affordance is optional on polite tones, mandatory on
persistent ones.** A toast that never auto-dismisses without a dismiss button
is a squatter.

**Rebuilding it in a framework:** what must survive is the tone table — the
role/live/persistence mapping is the component's actual contract — plus the
single region and the hit-target floor on the dismiss button.

## Accessibility

- Politeness follows severity: `role="status"` + `aria-live="polite"` for
  neutral, good, and accent; `role="alert"` + `aria-live="assertive"` for
  warn and danger. A success must not interrupt; a failure must.
- A toast **never takes focus**. Announcement is the live region's job;
  stealing focus from the person's task to report on it is the interruption
  the polite/assertive split exists to avoid.
- The dot is `aria-hidden`; the words carry the tone for a screen reader,
  and shape-plus-color carries it visually — never color alone.
- The dismiss button carries `aria-label="Dismiss"` and pads its 10px glyph
  out to `size.hit-target-min` with a transparent hit area — the glyph
  shrinks, the target does not.
- The entrance animation honours `prefers-reduced-motion: reduce`.
- Persistent tones remain until explicitly dismissed, so an assistive-tech
  user navigating slowly is never raced by a timer.

## Known drift

- `Toast.tsx` draws its dismiss button at 20px with no hit-area padding —
  below `--sem-size-hit-target-min: 24px`. The token is the spec; the
  undersized target rides with the overlay-geometry pass, **MC-2110**.
- The shipped kit leaves toast *placement* to each host (the component takes
  a `className`). The region above is the reference placement consuming
  `--sem-z-toast`, which no shipped surface consumes yet — also **MC-2110**.
