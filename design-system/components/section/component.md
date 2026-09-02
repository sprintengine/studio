# Section

A titled region of a panel or pane: a one-line heading row — title, optional
canonical count, at most one trailing control — over its content. Extracted
from the source product's `Section`
(`src/renderer/src/components/ui/Section.tsx`).

A section groups with **space and a heading**, which is the system's answer
before any container: no card, no fill, no border box around the content. If
the content genuinely needs containment, that is a different decision made for
a stated reason — not this component growing chrome.

**A heading must separate something from something else.** One section alone
on a surface is not a group; render its content bare and let the surface's own
name (the panel title, the list's accessible name) carry the label. The title
is optional for exactly this case — a section with no title is just the
padding contract.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Region | `.ds-section` | yes — a real `<section>` |
| Header row | `.ds-section-header` | when titled — baseline-aligned, `space.sm` gap |
| Heading cluster | `.ds-section-heading` | with the header — title + count, `space.xs` gap, shrinks first |
| Title | `.ds-section-title` | with the header — an `<h2>`–`<h4>`, truncates |
| Count | `.ds-section-count` | no — `tabular-nums`, `text.muted` |
| Action | `.ds-section-action` | no — **one** trailing control |
| Body | `.ds-section-body` | yes — the content, inset unless `--flush` |

The title is `font.size.meta` at `font.weight.emphasis` in `text.primary` —
a weighted label, **never** uppercase letter-spaced chrome. Sentence case.
The heading element's level (`h2`–`h4`) follows the document outline, not the
type size: every section title renders identically whatever its level.

The header's padding (`space.lg` sides and top, `space.xs` below) and the
body's inset (`space.lg` sides and bottom) share one left edge, so the title
and its content sit on the same vertical line.

## Variants

- Default — body inset to the section's padding.
- `ds-section--flush` — no body inset, for content that brings its own edge
  contract: a list whose rows own full-width hover fills, a table, a divider
  stack. The header keeps its padding either way.
- `ds-section--flush-header` — the body inset drops **and so does the header's**,
  so the title, the count and a trailing control share the rows' left edge.
  Added 2026-09-02: `--flush` alone leaves the heading 12px inboard of rows that
  render flush to x=0, which reads as a misalignment rather than a hierarchy.
  Reach for it only when the body's rows genuinely have no inset of their own —
  a list of `inbox-row`s carries its own, and the header must stay inset to
  line up with it.

## States

None. A section is structure, not a control — it has no hover, no selection,
no disabled. Interactive states belong to the things inside it.

## Usage

- **One trailing control, and a ceiling of one.** A "New…" button, a filter
  glyph, an overflow menu — one of them. Two controls in a section header is
  the second chrome band forming; the second control belongs inside the
  content, behind the overflow, or nowhere.
- The count is the canonical count, shown once. If the content below also
  numbers itself, one of the two goes — the same count in two places is two
  chances to disagree.
- The count states fact, not activity: it does not pulse, tint, or turn into a
  badge. A count that needs attention semantics is a status, and statuses
  belong on the rows that have them.
- Do not nest a titled section directly inside a titled section with no
  intervening content — that is two headings labelling one thing. Nested
  sections are legal when each genuinely separates groups; step the heading
  level (`h3` → `h4`), never the type.
- Sections stack with space between them, not rules. A divider between every
  section restates what the headings already say.

## Accessibility

- The region is a native `<section>`; give it `aria-labelledby` pointing at
  the title's id when the surface holds several, so the regions are navigable
  landmarks with names.
- The title is a real heading element at the level the document outline
  requires — assistive tech navigates by outline, and a `<div>` styled as a
  heading is invisible to that.
- The count is part of the section's announced name only when it matters;
  it is text, not an `aria-label` — screen readers read it in place.
- The trailing action is a normally-focusable control in source order after
  the title, so Tab reads title-then-action, matching the visual order.

## Known drift

Shipped `Section.tsx` matches this spec structurally (it is the source of it);
its paddings are written as Tailwind steps (`px-3`, `pt-3`, `pb-1.5`) that
land on the space scale's 12px and 6px but bypass the variables. Token canon:
`space.lg` and `space.xs`.
