# Inline notice

The scoped error or warning card: a failure or degraded state rendered inside
the section, drawer, or detail pane it belongs to. Extracted from the source
product's `InlineNotice` (`src/renderer/src/components/ui/InlineNotice.tsx`),
whose header comment is the tone convention's document of record; this entry
is that convention's home in the system.

**The tone vocabulary — one rule every surface follows:**

- **danger** (red) — a FAILURE. Something the user tried did not happen.
  Always paired with a recovery action — a retry, a reconnect, an "open
  settings" — never a dead end.
- **warn** (amber) — DEGRADED BUT WORKING. The feature still runs, reduced or
  paused: a token expiring soon, posting paused, a partial result. Never
  color a hard failure amber, and never a degraded state red.

Panel-spanning conditions belong to the `banner`; transient confirmations to a
toast. The inline notice is for the state that lives *here* — next to the form
that failed, inside the pane whose sync is paused.

## No left tone-bar

One idiom for both tones: a **1px neutral hairline**, the tone's **soft
tint**, and the **tone glyph at the leading edge**. The body text stays
neutral and readable; the glyph carries the tone, the tint reinforces it —
which is why the notice survives grayscale.

A 2px colored stripe down one edge is decoration wearing a hairline's
clothes: it **doubles the card's own border**, it **breaks the 1px hairline
rule**, and it leaves the tone **carried by color alone**. It is on the
reject-on-sight list in `foundations/principles.md`, and this component is
where the temptation arises — so it is stated here too.

The glyphs are the app's lifecycle vocabulary, not a new icon set: `failed`
(ring + ×) for danger, `needs_input` (ring + !) for warn. A notice and a row
reporting the same condition say it with the same shape.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Card | `.ds-inline-notice` | yes — `border.subtle` hairline, soft tint, `radius.control` |
| Glyph | `.ds-inline-notice-glyph` | yes — `icon.size.sm` lifecycle glyph in the tone hue, `aria-hidden` |
| Body | `.ds-inline-notice-body` | yes — everything after the glyph; shrinks first |
| Title | `.ds-inline-notice-title` | structured card — the plain sentence, `font.size.body` in `text.primary` |
| Hint | `.ds-inline-notice-hint` | no — what it means, `font.size.meta` in `text.muted` |
| Details | `.ds-inline-notice-details` | no — a collapsed `<details>` disclosure; the raw string renders in `.ds-inline-notice-detail`, a mono block |
| Actions | `.ds-inline-notice-actions` | structured card, danger: required — recovery buttons on their own row |
| Trailing action | `.ds-inline-notice-trailing` | plain advisory — the one action at the trailing edge |

## Variants

- **Structured card** (title present) — plain sentence → what-it-means hint →
  collapsed raw detail → action row. The shape for failures: feed it from the
  error-presentation layer, not from the exception.
- **Plain advisory** (no title) — a single neutral line with the glyph, and
  the action inline at the trailing edge. The shape for short degraded-state
  notes.
- `ds-inline-notice--danger` / `ds-inline-notice--warn` — the two tones.
  There is no info tone and no success tone: information is content, success
  is the state the screen shows.

## States

| State | Treatment |
|---|---|
| Present | The condition holds; the notice sits in flow at its scope |
| Details closed | Default. The raw string exists but does not shout |
| Details open | `<details>` disclosure; mono block on `bg.surface` behind a `border.default` hairline, `radius.chip` |
| Resolved | Unmounts. No success residue |

## Usage

- **The raw string never renders inline.** ENOENT, an HTTP body, a zod trace,
  a stack — behind "Show details", always. The title is a sentence a person
  can act on; the detail is evidence for the one who wants it.
- The title reports the result, not the inventory: "Could not save the
  workspace", not the writer's internal state. The hint carries the one fact
  the screen cannot show.
- Danger notices end in a recovery action. If no recovery exists, the honest
  action is navigation — "Open settings", "View log" — not nothing.
- Scope it where the state lives: beside the failed form, at the top of the
  degraded section — not hoisted to the panel edge (that is the banner's job)
  and not floated over content (that is a toast's).
- One notice per condition. A form with three invalid fields gets three field
  errors (see `field`), not three notice cards.

## Accessibility

- `role="alert"` for danger — failures interrupt. `role="status"` for warn —
  degradation informs politely. The role announces the tone, which is why the
  glyph can stay `aria-hidden`: decorative to a reader, shape-carrying to an
  eye.
- The disclosure is a native `<details>`/`<summary>` — keyboard-operable and
  state-announced for free. Do not rebuild it as a div with a click handler.
- Actions are real buttons in source order after the message, so a reader
  hears problem → meaning → recovery.
- The mono detail block may scroll horizontally; it is inside the disclosure,
  so it never traps a keyboard user who did not opt in.

## Known drift (MC-2115)

Shipped `InlineNotice.tsx` conforms to this anatomy — it is the source of it.
Its spacing is written as Tailwind steps that land on the scale but bypass
the variables, and the app-wide consolidation of hand-rolled notice surfaces
onto this component is tracked as MC-2115.
