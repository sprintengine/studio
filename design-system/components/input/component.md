# Input

Extracted from the source product's `Field` wrapper (label + control + one
supporting message) and its raised input chrome at `size.control.sm`.

## Anatomy

- `ds-field` — vertical stack, 6px gap: label, control, one supporting
  message.
- `ds-field-label` — `font.size.body` at `font.weight.medium` in
  `text.default`; a required mark (`*`) in `status.danger` is `aria-hidden`
  and mirrored by `aria-required` on the control.
- `ds-input` — a `size.control.sm` control on `bg.surface-raised` with a
  `border.default` hairline and `radius.control`.
- `ds-field-help` / `ds-field-error` — `font.size.meta`; help in
  `text.subtle`, error in `status.danger`.

## Variants

- Default text input. The same chrome serves search inputs (add a leading
  `search` glyph) and other single-line controls.

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

## Drift ruling (MC-2118, 2026-08-05)

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
