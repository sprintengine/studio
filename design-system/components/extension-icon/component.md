# Extension icon

The mark a third-party thing wears everywhere it appears. One drawing, one
plate, one fallback — so a server that reads as GitHub in the Extensions door
reads as GitHub in the connector row, in the composer's picker and in the
workspace aside, and a skill's letter chip is the same letter chip in all four.
Extracted from the shipped `ExtensionIcon` primitive
(`src/renderer/src/components/ui/ExtensionIcon.tsx`).

This is an **identity** slot, not an iconography slot. A
[glyph](../glyphs/component.md) is drawn by this system and speaks its
vocabulary; this holds artwork the system did not draw and cannot restyle. The
principles' *Identity colour* clause is what lets that artwork keep its own
hue: a vendor's mark wears the vendor's colour, and the accent budget does not
count it, because the colour is not ours — it names something.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chip | `.ds-extension-icon` | yes, unless the artwork brings its own plate — a square at `radius.shell`, `bg.surface-raised`, `border.default` hairline |
| Artwork | `.ds-extension-icon-art` | one of three: a mark this system ships, a fetched brand glyph, or the monogram |
| Monogram | `.ds-extension-icon-monogram` | the fallback — one or two mono letters from the entry's name |
| Plated artwork | `.ds-extension-icon--plated` | the modifier for artwork that is already a plate: no chip, no hairline, no ground |

Everything scales from a single `size` (default 36px), through
`--ds-extension-icon-size`: the shipped mark occupies **72%** of the box, a
fetched brand glyph **62%** (it arrives with no padding of its own), and the
monogram sets at **42%** of it. Those ratios are the component's, not the
caller's — a caller passes one number.

## Variants

Four sources, resolved in a fixed order, and the order is the component's
whole argument:

1. **A mark we ship ourselves** outranks everything. An id this system
   recognises is a stronger answer than any URL, and it needs no network.
2. **The entry's own icon, when it brings its own plate.** An app icon is
   already drawn on a rounded ground and reads on any theme; wrapping it in the
   neutral chip puts a white frame around a framed thing (owner ruling
   2026-09-01). This is the one variant with no chip.
3. **The entry's own icon, flat**, or the brand glyph fetched by slug. Both
   keep the chip, because a flat mark needs a ground: ~110 catalogue marks are
   near-black and vanish bare on a dark theme.
4. **The monogram.** One or two uppercase letters from the name, in
   `font.family.mono` at the emphasis weight — mono because it is an
   identifier, not prose.

The chip is the safe wrong answer and the plate is not: a remote URL cannot be
inspected without fetching it, so it keeps the chip. A vanished icon is a worse
failure than a redundant frame.

## States

| State | Treatment |
|---|---|
| Rest | The only state. The mark is identity, and identity does not hover |
| Loading | No skeleton, no spinner. The chip is already the right size and the right ground; a placeholder inside it would be a second frame that flashes |
| Fetch failed | Falls to the next source down the list, ending at the monogram. There is no broken-image state |
| Inside a hovered or selected row | Unchanged — the row paints around it |

The fallback chain is what replaces an error state: every entry has a name, so
every entry has a mark.

## Usage

**One slot per entry, one size per surface.** A door tile, a list row and a
picker row each pick a size and hold it for every entry in that view. Two
sizes in one list makes the column ragged and reads as two kinds of thing.

**Never re-tint the artwork.** No baked tint, no `currentColor` recolouring, no
opacity for a disabled row. A tint is invisible on the opposite theme, and the
mark is the one thing on the row whose colour is not the system's to spend.

**It never carries status.** Availability, enablement and errors belong to the
row's status idiom — a dot, a lifecycle glyph, an [inline
notice](../inline-notice/component.md). Dimming the mark to say "disabled"
spends the identity channel on a state.

**Do not build a second one.** This lives in `ui/` rather than beside the
catalogue it was born in precisely so a view model with no access to that
component graph can still render the mark. A local copy is how two surfaces
start disagreeing about what GitHub looks like.

## Accessibility

- The mark is **always decorative**: `aria-hidden`, and `alt=""` on the image.
  It rides a row that names the thing in text, and a screen reader reading
  "GitHub GitHub" is the duplication the icon rules exist to prevent.
- Because it is decorative it is never the only carrier of identity. A surface
  that shows the mark alone — with no name beside it, in text or as the
  control's accessible name — is the wrong surface for it.
- The image is `loading="lazy"` and `decoding="async"`, and the box holds its
  size before the artwork lands, so a long list does not reflow as marks
  arrive.
- The monogram is real text at `font.weight.emphasis`, and its ink clears AA
  on the chip's ground in both modes.

## Known drift

- **The chip's three colours have no `sem.*` tokens.** The shipped primitive
  spends `--icon-chip-bg`, `--icon-chip-border` and `--icon-chip-ink` — app-level
  values with no counterpart in `foundations/tokens.tokens.json`, so the chip is
  the one part of this component the bundle cannot describe. The CSS here reads
  the nearest semantic steps instead (`bg.surface-raised`,
  `border.default`, `text.muted`), which is what the chip is *for*; promoting the
  three to real tokens, or retiring them onto these, is open.
- **`ExtensionIcon` is not in the kit's barrel** (`ui/index.ts`), so the
  "every export resolves to an entry here" clause in `USAGE.md` never covered
  it. This entry closes that gap; the export belongs in the barrel when the
  file next moves.
- The 72 / 62 / 42 percent ratios are computed in JavaScript from the `size`
  prop rather than expressed in CSS. A framework rebuild should express them
  as percentages of the box, as the CSS here does — the numbers are the
  contract, the arithmetic is not.

## Shipped implementation

`src/renderer/src/components/ui/ExtensionIcon.tsx`, with
`iconHasOwnPlate` (`ui/iconPlate.ts`) deciding variant 2 by reading the SVG
itself — a `<rect>` or `<circle>` covering ~90% of the viewBox in a real fill
is a plate — and `mcpMonogram` (`ui/mcpMonogram.ts`) producing the fallback
letters.
