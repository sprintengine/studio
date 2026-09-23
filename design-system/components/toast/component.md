# Toast

The transient report. A toast announces the result of something the person
just did — or a failure they must not miss — from the viewport's corner,
without taking focus and without asking anything back. It is the answer to
"did it work?" in one line: a count, a name, a state. Extracted from the
source product's `Toast` primitive (`src/renderer/src/components/ui/`).

A toast never carries a question (that is a modal), never carries the only
route to an action (a surface that must be acted on is a banner or an inline
notice, which stay put), and never dumps the operation's inventory — file
counts, hashes, byte sizes are stored, not displayed. The one crack in the
first rule is the answer-in-place variant below, held to a single field and a
persistent surface the request is also readable behind.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Region | `.ds-toast-region` | yes — the fixed corner stack at `z.toast`; one per document |
| Surface | `.ds-toast` | yes — `role` and `aria-live` chosen by tone (below) |
| Tone dot | `.ds-toast-dot` | yes — the 6px status idiom, `aria-hidden` |
| Content | `.ds-toast-content` | yes — title `.ds-toast-title`, optional description `.ds-toast-description` |
| Answer row | `.ds-toast-answer` + `.ds-toast-code` + `.ds-toast-help` | no — the answer-in-place variant's one field and its two answers |
| Dismiss | `.ds-toast-dismiss` | no — trailing icon button, `aria-label="Dismiss"` |

The surface is **glass** (owner ruling 2026-09-04): `bg.surface-raised` at `glass.opacity` over a `backdrop-filter` of
`glass.blur` and `glass.saturation`, a `border.default` hairline, and
`shadow.popover` drawing the edge over whatever shows through. Where
`backdrop-filter` is unsupported the card is solid `bg.surface-raised`.

The blur ban (`principles.md`, the modal and drawer specs) exists because a
full-viewport scrim re-samples every terminal pane under it every frame; a
toast's area is a corner, a fraction of that cost.

**Amended 2026-09-07 (owner ruling): two surfaces blur, not one.** The
conversation peek — the hover card that shows what a chat was asked, drawn
deliberately over a running terminal — is the second, through
`PointerPopover`'s opt-in `material="glass"`. It is a larger area than a
toast and this is not pretended otherwise: the ruling accepts that cost for a
surface whose whole point is to sit *over* the app it is describing, while
the area argument still holds against the thing it was written for, a
full-viewport scrim. **Amended again 2026-09-08:** the trigger-anchored
`Popover` carries the same opt-in, for the composer's skill type-ahead drawn
over the transcript being read — the popover spec's "Material" section had
already ruled glass a material of the whole popover family, and the anchored
shell is that family's engine. **Amended 2026-09-10:** the
[command palette](../command-palette/component.md)'s shell is the fourth,
and the first at dialog scale over the middle of the window where the
terminals are. It is affordable for a reason the earlier three did not have:
the palette holds the terminal repaint pause for its lifetime (the hold
`Modal` takes), so the panes beneath it stop invalidating and the blur is
computed once rather than on every PTY chunk — which is what the ~10fps
measurement actually was. Its scrim stays a plain tone; the area argument
still holds against a full-viewport blur. The conformance lint pins the glass
utility to those four **kit shells** (`Toast.tsx`, `PointerPopover.tsx`,
`Popover.tsx`, `CommandPalette.tsx`); a product file that blurs, or borrows
the utility directly, is still a violation — a surface that wants glass asks
the shell for it.

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

**The action row, two consumers.** Owner ruling 2026-09-04: the CLI-update
toast ("Update available: Codex 0.153.3")
carries `.ds-toast-actions` with **Settings** (ghost) and **Update** (primary),
and `.ds-toast-glyph` — the agent CLI's icon — in place of the tone dot. It
stays for one minute, not five seconds and not forever (owner ruling
2026-09-18): long enough to reach for Update, short enough that an unasked-for
notice does not sit in the corner until clicked. Missing it loses nothing — the
bell and the Settings row carry the same news. Once Update is pressed the
toast becomes that update's report, and its buttons go with the question
they answered. "Undo" in a toast is still an action on a timer racing its own
dismissal and still belongs where the change is visible; a further consumer of
the action row is a design decision to record here, not a styling choice.

**The action row's second consumer (owner ruling 2026-09-23).** The app-update toast
("SprintEngine Studio 0.6.0 is ready") carries **Later** (ghost) and **Restart
to update** (primary), with the good tone's dot. The update has already
downloaded in the background, so the one question left is when to restart, and
it is asked where the person is working rather than behind a trip to Settings.
Unlike the CLI-update toast it stays until answered: it appears once per
downloaded version, and a restart prompt that times out while the person looks
away is how an update ends up found by accident. Later is the dismissal, and
loses nothing — the update installs at the next quit, and the bell row and the
Settings version row still say it is ready. Once Restart is pressed the toast
becomes the restart's report, as the CLI-update toast becomes its update's.
These two are the only toasts in the system with buttons.

**The answer-in-place row, one consumer.** Owner ruling 2026-09-05: the
incoming pair-request toast carries `.ds-toast-answer` — a six-digit
`.ds-input`, then Decline (ghost) and Allow (primary) — with `.ds-toast-help`
under it holding the instruction, or the refusal in `status.danger` ink. It is
the one toast in the system with a field, and it earns it: the answer IS six
digits, read off the screen of the machine asking to pair, and every other
route to typing them (a popover, a settings tab) walks the person away from
the screen they are reading. The toast never auto-dismisses — a surface
holding a half-typed code that vanishes on a timer is worse than no surface —
and the request stays answerable on its own persistent card, so a dismissed
toast loses nothing. Everything the field cannot express stays on that card:
this variant grants the request's DEFAULT authority and nothing a checkbox
would have chosen. A second consumer, or a second field, is a modal.

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

The region is shipped as **`ToastRegion`**
(`src/renderer/src/components/ui/ToastRegion.tsx`) — mounted once per document,
reading the toast store every producer writes to, and rendering nothing at all
when the store is empty. Three properties are the component rather than the
consumer's business, and a rebuild keeps all three:

- **It draws nothing.** No surface, no ground, no border, no elevation. The
  card is the glass; the region is a `role="presentation"` stack.
- **It swallows no clicks.** The stack is `pointer-events: none` and each toast
  surface reclaims its own, so an empty or animating region never blocks the
  pane under that corner — a fixed transparent box over the app is a dead zone
  nobody can see.
- **It is fixed width.** Every card is the same measure (340px) regardless of
  its content, so a stack of three reads as one column rather than as a ragged
  edge.

**Report the result, not the inventory.** "Automation archived" — not the branch,
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

None. Both entries that stood here were spent on 2026-08-05 (the menu-row sweep):

- The dismiss target was 20px, under `--sem-size-hit-target-min`. `Toast.tsx`
  now takes its floor from that token directly, keeping the 10px glyph and the
  flow advance the smaller target had.
- The placement note pointed at the overlay-geometry sweep, which had already shipped.

*2026-09-05:* the answer-in-place variant, above, was ruled and consumed in
the same breath — the remote epic's pair-request toast stopped pointing at the
Remote glyph and started taking the code. Its `content` slot is one rendered
body between the description and the action row; the shipped kit's store
documents the same single-consumer rule the action row carries.

*2026-09-04:* the corner region is consumed. The remote-sessions-ux epic's
`toast-host-region` child shipped `.ds-toast-region`'s product counterpart —
one bottom-trailing stack at `z.toast`, newest at the bottom, `space.sm`
apart — and every producer (pair requests, remote-create failures, stranded
attachments) routes through it. The older in-flow toast host at the top of a
scrolling pane remains where a toast belongs to the panel that produced it;
it stacks nothing and is not the region.
