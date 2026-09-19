# Input

Extracted from the source product's `Field` wrapper (label + control + one
supporting message) and its raised input chrome at `size.control.sm`.

## Anatomy

- `ds-field` — vertical stack, 6px gap: label, control, one supporting
  message.
- `ds-field-label` — `font.size.body` at `font.weight.medium` in
  `text.default`; a required mark (`*`) in `text.subtle` — neutral, because an
  untouched required field is empty, not invalid (see `field`) — is
  `aria-hidden` and mirrored by `aria-required` on the control.
- `ds-input` — a `size.control.sm` control on `bg.surface-raised` with a
  `border.default` hairline and `radius.control`.
- `ds-field-help` / `ds-field-error` — `font.size.meta`; help in
  `text.subtle`, error in `status.danger`.

## Variants

- **Default** — the field material: `bg.field` (the raised surface on an opaque
  window, translucent under glass), a `border.default` hairline,
  `radius.control`. A field READS as raised: it is the thing you put something
  into. The same chrome serves search inputs (add a leading `search` glyph) and
  other single-line controls.
- **`--well`** — the recessed step, on `bg.app`, for a control inside a settings
  row where the body is already `bg.surface` and a raised field would have
  nothing to lift away from.

### Variants whose box belongs to something else (2026-09-08)

Three cases where the default box was the wrong **object**, not the wrong
colour. Each existed as a hand-roll in the consuming product, and each hand-roll
began by cancelling four things the field chrome had decided.

- **`--quiet`** — transparent ground, a `border.subtle` hairline, and **no hover
  lift**. For a field inside an already-grounded floating surface: a filter box
  at the head of a popover, a search inside a menu. There the field ground reads
  as a second panel nested in the first — the card-in-a-card *Hairlines carry the
  structure* rejects — and a border moving on hover inside a surface that already
  has one reads as the surface itself changing.
- **`--seamless`** — **no box at all**: no border, no ground, no radius, and no
  focus indicator of its own. The visible box is the **wrapper**
  (`ds-field-box`), which draws the border and takes the ring keyed to the
  field's own focus. The system already shipped the wrapper half of this pattern
  and had no field to put inside it.

  Keyed to the field's focus, **never `:focus-within`**: a clear button or a send
  button in the same box is a descendant, and a `focus-within` outline stays
  painted while that button draws its own, putting two indicators on one stop.

  Never ship one without a wrapper that lights up. A seamless field alone has no
  focus indicator, which is a defect rather than a style.
- **`--inline`** — the title edited **in place**. Quiet at rest, revealing the
  field chrome on hover or focus, so the head of a page reads as a heading rather
  than as a form field wearing one, and the name is still one click away. It
  states no font size: the type step is the surface's own decision, and one here
  would be a second `font-size` for the cascade to resolve.

## Sizes

`sm` (`size.control.sm`) is the default and the panel-chrome standard: an input,
a select and a button sharing a row all sit on it. `md` is the overlay step.

**`xs` (`size.control.xs`, 26px)** was added on 2026-09-08 for the dense numeric
or mono box in a toolbar of 26px icon buttons — a viewport width, a browser
address bar — where a 30px field is the tallest thing in the row. It is a ramp
step being *used*, not a height being invented, and the type drops with it to
`font.size.meta`, which is what makes the cursor and its inset fit. It is not a
licence to shrink a labelled form field, which stays at `sm`.

The `seamless`, `composer` and `inline` variants take **no** size step whatever
the caller asks: their host owns the box, and a height here would be the one
thing the caller then had to cancel.

## Textarea

The multiline member of the same vocabulary — the field chrome above, with the
height coming from `rows` and the content instead of the ramp, so the size step
spends itself on the block inset. A textarea and the input above it in one form
are the same field at two lengths.

- **`--composer`** — `seamless` for the multiline case, plus content sizing: the
  box grows with what is typed, between the caller's bounds. A variant of its own
  rather than a flag on `seamless`, because a single-line field that
  content-sized would grow *sideways*, and the two must not be reachable by one
  name. The chat composer is its one surface: the wrapping composer material
  draws the border, the ground and the elevation, and takes the ring keyed to the
  textarea's own focus, while the ref, the row count and the paste, context-menu
  and key handlers pass straight through to the element.
- **`--quiet`** — the same quiet ground as the single-line variant, for a note
  composer inside a floating card.

## States

- Hover: border moves to `border.strong`.
- Focus: the shared 2px `border.focus` ring, and nothing else — the border
  does not change colour.
- Invalid: `aria-invalid="true"` moves the border to `status.danger`; the
  error message replaces the help text (never both).
- Disabled: `text.disabled` ink, reduced opacity, `not-allowed` cursor.
- Placeholder: `text.disabled`.

## Usage

- Exactly one supporting message at a time — help hides while an error shows.
- Labels are sentence case, no trailing colon.
- Do not stretch inputs beyond their content column; `size.control.sm` is the
  panel-chrome standard height.

## Accessibility

- The label is a real `<label for>` pointing at the control.
- `aria-describedby` points at the visible help or error message, whichever
  is shown.
- Invalid state is conveyed by `aria-invalid`, not color alone (the error
  text names the problem).

## Drift ruling (2026-08-05)

Reconciled against `src/renderer/src/components/ui/Input.tsx`. **The shipped
behaviour wins on both counts**, and the States section above now describes it.

- **No focus border swap.** The spec moved the border to `accent.primary` on
  focus *as well as* drawing the ring. Two signals for one state, and the
  border one is the weaker: it is a 1px hue change on a control that already
  has a 2px ring around it, and it spends the accent on a state that is not a
  choice the person made. Every other focusable control in the system — button,
  switch, segmented control, checkbox, menu item — says focus with the ring
  alone; an input saying it twice is the odd one out. Hover keeps
  `border.strong`, which is a real second state the border is free to carry.
- **Placeholder ink is `text.disabled`.** Placeholder text is not content and
  must sit clearly below the value that replaces it; `text.subtle` is close
  enough to real input ink to read as a filled field at a glance.

The reference CSS in `component.css` moves with this ruling.

## Shipped implementation

`src/renderer/src/components/ui/Input.tsx`, exporting `Input`, `Textarea` and
`INLINE_TITLE_EDIT_CLASS`. That constant is the `inline` variant's chrome,
exported separately because several sites consume it on an element of their own
where the type step is theirs to set; a caller who wants only the chrome should
take the variant, so the primitive is what draws it.
