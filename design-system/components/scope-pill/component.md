# Scope pill

One machine-readable **scope name** in a pill: `terminal:control`,
`workspace:read`. It is the mark for a permission identifier wherever the
product shows the person the actual strings — the pairing code's grant list,
the popover that says what a paired machine may do here, the request a peer
sent.

Set in mono, at `font.size.micro`, on `radius.pill` with a `border.default`
hairline and a `bg.surface` ground. 22px tall, `space.sm` of inline padding.
Display only, always.

## Why neither existing mark could be it

Read [badge](../badge/component.md) and [micro-chip](../micro-chip/component.md)
first; this entry exists because both were tried and both were wrong for the
same underlying reason.

**They are UI-face labels. This is code.** A badge says "draft", "merged", "3".
A micro chip says "Default". Those are words *about* the thing beside them,
written in the reader's language, in the UI family, in sentence case. A scope
pill's content is not a word about anything — it **is** the identifier, the same
string that appears in the pairing request, in the audit line, and in the
`terminal:observe` a person will paste into a search box or an issue. Three
consequences follow, and each of them is a rule one of those two components
holds the other way:

| | badge | micro-chip | scope pill |
|---|---|---|---|
| Family | UI | UI | **mono** |
| Tone | `status.*-soft` fills, a tone per state | none, permanently | none, permanently |
| Shape | `radius.pill` | `radius.chip` (rectangular, explicitly) | `radius.pill` |
| Content | a state word or a count | one fact, one or two words | an API identifier |
| Tracking | — | `tracking.wide` | `tracking.normal` |

- **The family is not a style choice here.** `terminal:control` at 11px in the
  UI family is exactly where `l` / `1` / `I` and `:` / `;` stop being
  distinguishable, and a person reading this list is deciding what another
  machine may do on this one. Mono is what makes the string checkable.
- **It can never take a tone**, which rules out the badge family outright: the
  badge's whole vocabulary is `status.*-soft` fills that grade a state, and a
  scope has no state. It is held or it is not, and *that* is said by the
  heading above the set, not by a colour on the pill.
- **It is a pill, and micro-chip hands the rectangle back on purpose** — that
  entry quotes badge's ruling that "`radius.chip` is the right token for a
  *rectangular* chip". A wrapped set of eight colon-joined strings needs the
  round end to read as eight objects rather than as one broken line; the
  rectangle at that density reads as a table with no rules.

The shortest form of the test: reach for a badge when the mark would change,
for a micro chip when it would not, and for this when the mark is not a word at
all.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Pill | `.ds-scope-pill` | yes — an inline `<span>` (or an `<li>` inside a set) holding exactly one scope name |
| Set | `.ds-scope-pill-set` | no — the wrapping container, `space.xs` in both axes |

No glyph slot, no dismiss affordance, no count, no truncation. A pill holds one
identifier and the whole of it: a scope shown as `terminal:cont…` is a scope
that does not exist.

## Variants

- **Granted (no modifier).** `border.default`, `text.default`, `bg.surface`.
  The default, because the common list is the list of what a machine *has*.
- **`--missing`.** One step quieter on both axes — `border.subtle` and
  `text.subtle` — for a scope listed as *not* granted beside the ones that are.
  It is deliberately not a `status.danger` tint: a scope the person never
  granted is a fact, not a fault, and tinting it red would say the opposite of
  what the surface means. The difference is shape-coded by the heading the set
  sits under ("Granted scopes" / "Not granted"); the ink step alone is never
  the only carrier.
- **No tone variants, ever.** See above. A scope pill that went green would be
  a second status idiom on a surface whose whole content is already a
  permission state.

## States

| State | Treatment |
|---|---|
| Rest | The only state |
| Hover / focus / pressed | None. It is not interactive and must not advertise a click it does not have |
| Inside a hovered row | Unchanged — the row paints `bg.hover` behind it; the pill's own `bg.surface` ground is what keeps the identifier legible over it |
| Disabled | Not a state this has. A pill in a disabled region dims with the region |

## Usage

- **One scope per pill, and the pill never truncates.** A set that does not fit
  wraps to another line. If the surface cannot afford the wrap, it is showing
  too many scopes and wants the popover's mono list instead.
- **Use a set, not a sentence.** Comma-joining scopes into prose is what this
  replaces: the reader is counting and comparing, and prose defeats both.
- **The heading carries the meaning, the pill carries the name.** "Granted
  scopes" over a set; "Not granted" over a `--missing` set. Never a pill that
  tries to say both, and never a mixed set where held and unheld sit together
  separated only by ink.
- **Never interactive.** No `onClick`, no dismiss ✕, no filter behaviour. A
  scope a person can act on is a [check row](../check-row/component.md) — that
  is what the pairing dialog uses — or a [button](../button/component.md). The
  pill is what the choice looks like once it has been made.
- **Not a general-purpose mono chip.** It is named for what it holds. A commit
  SHA, a branch name and a file path are not scopes; if one of those wants a
  mark, that is a new entry with its own argument, not this one widened.

## Accessibility

- Plain text in the document, read in the surface's reading order. It takes no
  `role` and no `aria-label`: the identifier is the content, and naming it
  would say the same string twice.
- **The set takes the accessible name, not the pill.** A `<ul class="ds-scope-pill-set">`
  with an `aria-label` ("Scopes in this code") is what tells a screen-reader
  user what the eight strings underneath it are; without it they arrive as
  eight unexplained identifiers.
- **`--missing` is never announced by its colour.** The heading above the set
  is the only thing that says "not granted", and it is real text, so the
  quieter ink is reinforcement rather than information.
- `text.default` on `bg.surface` clears AA at the 11px step, and the hairline
  gives the pill a non-text edge at 3:1. The `--missing` step keeps its
  hairline for the same reason: the mark survives greyscale because it never
  depended on a colour.
- Never focusable, and it adds no tab stop to a surface that is already a
  popover or a card.

## Shipped implementation

`src/renderer/src/components/ui/ScopePill.tsx`, exporting `ScopePill` and
`ScopePillSet` through the kit barrel (`ui/index.ts`).
