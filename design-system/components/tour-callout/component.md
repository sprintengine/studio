# Tour callout

One step of a diff tour, said beside the code it is about. Shipped as
`TourCallout` (`src/renderer/src/components/ui/TourCallout.tsx`); the
[tour strip](../tour-strip/component.md) is the band the tour plays under.

In the diff the callout lives **in the code**, not over it: a Monaco view zone
under the step's last line, sized to the callout, so the lines below move down
to make room and nothing is ever covered. The step's lines themselves are
marked, and everything else is set back, by three treatments that belong to
this entry because they only exist while a callout is showing.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Frame | `.ds-tour-callout-frame` | yes — the zone's content box: `space.sm` above, `space.md` below, the code's own left edge |
| Card | `.ds-tour-callout` | yes — `bg.surface-raised`, 1px `border.default`, `radius.control`, `space.md` × `space.lg`, at most `76ch` |
| Position | `.ds-tour-callout-index` | yes — `3/7` in `font.family.mono`, `tabular-nums`, `text.subtle` |
| Title | `.ds-tour-callout-title` | yes — `font.size.body`, `font.weight.medium`, `tracking.tight`, `text.primary` |
| Kind | [micro chip](../micro-chip/component.md) | no — "Context" or "Caveat"; an explaining step carries none |
| Steppers | button `--icon` `xs` | no — previous / next step, the diff's own step glyphs |
| Location | `.ds-tour-callout-location` | yes — `src/queue/retry.ts L40–43 (new)` in mono at `font.size.micro`, `tracking.wide` |
| Notice | [inline notice](../inline-notice/component.md) `--warn` | no — only for a moved or gone step, with the excerpt inside |
| Body | `.ds-tour-callout-body` | yes — the agent's markdown at the compact density |
| Ask | [input](../input/component.md) + [button](../button/component.md) `--outline` | yes — "Ask about this…" and **Ask** |
| Working edge | [working edge](../working-edge/component.md) | no — while the agent answers a question from this step |

### The code around it

| Treatment | How |
|---|---|
| The step's lines | a whole-line `bg.selected` wash — neutral, never a diff hue, never the accent |
| The step's gutter | a 2px `border.focus` hairline in the line-decorations lane: the accent, spent as a hairline and nowhere else |
| Everything else | text at `opacity: var(--tour-dim)`, where `--tour-dim` is a registered property the host eases from 1 to **`sem.opacity.dimmed`** |
| The overview ruler | a mark per step in the file; the current one in `border.focus`, the rest in `text.subtle` |

In side-by-side view the diff pads the other side by the callout's height on
its own, so the two sides stay line for line. A step on the **old** side plays
side by side (unified view draws removed lines as inline zones, which cannot
be pointed into); a **deleted** file plays as its old text, whole, unified.

## Variants

- **In the diff** (`data-variant="zone"`) — the default: in a view zone under
  the step.
- **Card** (`data-variant="card"`) — a file with no text to point into (binary,
  too large) has nowhere to hang a zone, so the same callout stands alone,
  centred, where the editor would be.

## States

| State | Treatment |
|---|---|
| Arriving | One motion at a time: the old callout and highlight fade out (`motion.duration.fast`), the editor scrolls to the new lines, then the highlight fades in and the callout follows (`normal`) as the dim settles |
| Moved | The code changed after the tour was written and the lines could not be found again: a warn notice, "This code changed after the tour was written", with the excerpt the step pointed at. Its text is kept; it is never skipped |
| Gone | The file left the diff: the same notice, "This file is no longer in the diff", and the excerpt |
| Queued | A question waiting for the agent's turn to end: "Queued · sends when the agent is ready" and Cancel, in place of the field |
| Answering | The working edge runs round the card; one line says the agent is answering in its terminal |
| Author gone | "The agent that wrote this tour has exited." and **Ask a new agent** |
| Reduced motion | No fades, no eased dim, no smooth scroll: every step is a jump |

## Usage

- A callout is the agent's voice, so it says **why**, not what — the diff is
  already on screen. Its body is markdown and renders at the compact density.
- The callout never takes focus, and nothing about a step does. A person reads
  it, or clicks into its field, and only then does the keyboard go there.
- One callout at a time. The step list and the strip's pager are how the other
  steps are reached.
- Pointer over the callout, or focus in its field, holds the strip's Play.

## Accessibility

- The card is a `section` named "Step 3 of 7: <title>". It does not announce
  itself: the strip's pager already says which step this is.
- The ask field is named "Ask about step 3"; Enter sends, Escape clears and
  leaves the field. Keys typed there are the field's — `[` and `]` never step
  the tour from inside it.
- The moved/gone notice is a `status`, with its words; the excerpt's `+` / `-`
  lines keep their diff colours but the text is readable without them.
- The working edge is `aria-hidden` and speaks through its own `status` phrase.
