# Access summary

What an installed extension asks to reach on this machine, said at the depth
the surface can afford. Three parts, one vocabulary:

- **Glyphs** — on a list row. One warning triangle per scope that needs care,
  and nothing else. The titles are a hover or a Tab away.
- **Care list** — in the extension's details and its trust review. Each scope
  that needs care as a short title over a why of six words or fewer, and in the
  details the raw scope id beneath it.
- **Chips** — the scopes that need no second look, as a wrapped set of quiet
  pills.

The words are not this component's. Every capability scope has a short title,
and those that need care a why, in one table beside the full consent sentences
(`capabilityAccess` in `src/shared/modules/permissions.ts`). A scope the app
does not recognise always needs care, because nothing can say what it grants.

## Why the row gets glyphs and not words

A list of extensions used to carry each scope's consent sentence on the row:
"Call any of the app's internal APIs, including its own background code
(broad scope)", three or four of them under every name. Nobody reads a row of
warning sentences; they read as texture after the second row, which is the
opposite of what a warning is for. A count of triangles is read at a glance —
three asks for a closer look than one, and none draws nothing at all ("healthy
renders no mark", *Status is earned*). What the triangles stand for is one hover
or one Tab away, and the details and the trust review say it in full, so the
glyphs are never the only route to the list.

## Why it is not a badge, a scope pill or a tooltip alone

- **Not a [badge](../badge/component.md).** A badge grades a state with a tone.
  These are not a state of the extension; they are what it asked for when it was
  written, and they do not change while it is installed.
- **Not a [scope pill](../scope-pill/component.md).** A scope pill's content is
  the identifier. Here the reader is deciding whether to trust code, and
  `conversation:operate` tells them less than "Runs chats with your agents". The
  identifier is still shown — in mono, under the title, in the details — for the
  reader who wants to search for it.
- **The tooltip carries a short list, on purpose.** The [tooltip](../tooltip/component.md)
  entry rules out a list in a tooltip because a tooltip must never be the only
  route to a value. Here it is not: the list is the accessible name of the
  glyphs, the details popover and the trust review. The tooltip is the sighted
  reader's shortcut to the same three or four titles, one line per triangle, so
  the list reads back to the marks it explains.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Glyphs | `.ds-access-glyphs` | the row part — a focusable inline group with `role="img"` and an `aria-label` naming every title |
| Glyph list | `.ds-access-glyphs-list` | the glyphs' tooltip body — one line per triangle |
| Care list | `.ds-access-care` | the details part — a labelled `<ul>` |
| Care item | `.ds-access-care-item` | title, why, and optionally the id |
| Title / why / id | `.ds-access-care-title`, `-why`, `-id` | title required; why on every care scope; id in the details only |
| Chips | `.ds-access-chips` | a labelled `<ul>` of `.ds-access-chip` |

## Variants

None. The three parts are depths, not variants: a row takes the glyphs, a
details surface takes the care list and the chips, a trust review takes the care
list and the chips without the ids.

## States

| Part | State | Treatment |
|---|---|---|
| Glyphs | Rest | `status.warn` ink, no ground |
| Glyphs | Hover | `status.warn-soft` ground; the tooltip opens after the shared delay |
| Glyphs | Focus-visible | The shared ring, and the tooltip opens at once |
| Glyphs | None to show | Nothing is drawn — not an empty box, not a zero |
| Care list, chips | — | Display only. No hover, no focus, no pressed state |

## Usage

- **One triangle per scope that needs care.** Never a number beside a single
  triangle, and never a capped count: four scopes is four triangles.
- **Glyphs sit on the title line,** after the row's meta, so they read as a fact
  about the extension and not as a control beside the switch.
- **The why is six words or fewer.** "Calls GitHub as you", "Every chat on this
  machine". A why that needs a sentence is a scope that needs a better title.
- **Never imply enforcement.** The titles say what the extension says it does,
  never what the app prevents: no "sandboxed", no "restricted to".
- **Care first, then the rest.** A details surface lists the care scopes, then
  the chips under a quieter heading ("Also"), so the order is the argument.

## Accessibility

- The glyph group is one tab stop with `role="img"` and an `aria-label` of the
  form "Weather Deck needs care: Holds your API keys, Uses the network". A
  screen-reader user hears the list without opening anything; the tooltip is
  for the sighted reader and adds nothing the name does not already say.
- Each triangle inside is `aria-hidden`; the group is the image.
- Status is never colour alone: the triangle is the shape, the warn ink
  reinforces it, and the name says it in words.
- The care list and the chips are labelled lists (`aria-label`, e.g. "Needs
  care", "Also"), so the two groups are told apart without the headings being
  read first.

## Shipped implementation

`src/renderer/src/components/ui/AccessSummary.tsx`, exporting `AccessGlyphs`,
`AccessCareList` and `AccessChips` through the kit barrel (`ui/index.ts`).
Settings → Extensions is the first consumer: the row, the details popover and
the trust review.
