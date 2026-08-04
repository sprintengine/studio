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

- Focus: border moves to `accent.primary`; keyboard focus adds the 2px
  `border.focus` ring.
- Invalid: `aria-invalid="true"` moves the border to `status.danger`; the
  error message replaces the help text (never both).
- Disabled: `text.disabled` ink, reduced opacity, `not-allowed` cursor.
- Placeholder: `text.subtle`.

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

## Known drift

Verified against `src/renderer/src/components/ui/Input.tsx` (2026-08-04):

- **No focus border swap.** This spec (and the reference CSS) moves the
  border to `accent.primary` on focus; the shipped input never swaps the
  border — hover moves it to `border.strong`, and focus is the shared 2px
  ring only.
- **Placeholder ink.** Spec: `text.subtle`; shipped: `text.disabled`.

MC-2114 (Input/Field adoption) and MC-2118 (doc reconciliation) own ruling
which focus treatment wins and re-syncing this entry.
