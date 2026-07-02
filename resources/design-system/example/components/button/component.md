# Button

The single action control. One primary button per view; it shares the accent
with selection.

## Anatomy

- Container: `.ds-button` — accent fill, `sem.radius.control` corners,
  `sem.space.control-gap` internal gap.
- Label: sentence-case action verb, `sem.font.size.body` at
  `sem.font.weight.emphasis`.
- Optional leading icon: `.ds-button__icon`, 14px, `currentColor` stroke.

## Variants

- **Primary** (`.ds-button`) — `sem.color.accent.primary` fill with
  `sem.color.text.on-accent` label. The one call to action in a view.
- **Secondary** (`.ds-button--secondary`) — transparent fill,
  `sem.color.border.default` hairline, `sem.color.text.primary` label.
- **Danger** (`.ds-button--danger`) — `sem.color.status.danger` fill; only for
  destructive actions, always paired with confirmation.

## States

- Hover: primary lifts to `sem.color.accent.hover`; secondary strengthens its
  border to `sem.color.text.muted`.
- Focus: 2px `sem.color.accent.hover` outline with 2px offset, on
  `:focus-visible` only.
- Disabled: 50% opacity, `not-allowed` cursor, no hover response.

## Usage

- Name the action ("Save draft"), never enthusiasm or vague verbs ("Submit").
- One primary per view; everything else is secondary.
- Do not use danger styling for emphasis — it is a status color.

## Accessibility

- Real `<button type="button">` elements, never styled `div`s or bare links.
- Label contrast clears WCAG AA in both modes (`sem.color.text.on-accent`
  flips per mode with the accent).
- Icons are `aria-hidden` and decorative; the text label carries the meaning.
- Keyboard: native button semantics; visible focus via `:focus-visible`.
