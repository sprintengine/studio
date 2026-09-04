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

The surface is **glass** (owner ruling 2026-09-04): `bg.surface-raised` at `glass.opacity` over a `backdrop-filter` of
`glass.blur` and `glass.saturation`, a `border.default` hairline, and
`shadow.popover` drawing the edge over whatever shows through. Where
`backdrop-filter` is unsupported the card is solid `bg.surface-raised`.

This is the one surface in the system allowed to blur. The blur ban
(`principles.md`, the modal and drawer specs) exists because a full-viewport
scrim re-samples every terminal pane under it every frame; a toast's area is
a corner, a fraction of that cost. The conformance lint pins the glass to
this component — any other surface that blurs, or borrows the toast's
utility, is a violation.

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

**The action row, one consumer.** Owner ruling 2026-09-04: the CLI-update
toast ("Update available: Codex 0.153.3")
carries `.ds-toast-actions` with **Settings** (ghost) and **Update** (primary),
and `.ds-toast-glyph` — the agent CLI's icon — in place of the tone dot. It
never auto-dismisses: a toast asking for an action waits for the answer or the
dismiss. This is the only toast in the system with buttons. "Undo" in a toast is
still an action on a timer racing its own dismissal and still belongs where the
change is visible; a second consumer of the action row is a design decision to
record here, not a styling choice.

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
single region, the hit-target floor on the dismiss button, and the glass
staying the toast's alone.

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

None. Both entries that stood here were spent on 2026-08-05 (**MC-2138**):

- The dismiss target was 20px, under `--sem-size-hit-target-min`. `Toast.tsx`
  now takes its floor from that token directly, keeping the 10px glyph and the
  flow advance the smaller target had.
- The placement note pointed at **MC-2110**, which had already shipped.

*2026-09-04:* the corner region is consumed. The remote-sessions-ux epic's
`toast-host-region` child shipped `.ds-toast-region`'s product counterpart —
one bottom-trailing stack at `z.toast`, newest at the bottom, `space.sm`
apart — and every producer (pair requests, remote-create failures, stranded
attachments) routes through it. The older in-flow toast host at the top of a
scrolling pane remains where a toast belongs to the panel that produced it;
it stacks nothing and is not the region.
