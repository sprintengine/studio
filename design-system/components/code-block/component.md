# Code block

## Anatomy

A neutral bordered code surface with a header for language, optional filename,
wrap toggle and copy action. Source uses the mono family and body size.

## Variants

Unwrapped code scrolls horizontally. Wrapped code preserves whitespace and wraps
long lines. Unknown languages keep the same surface with plain source.

## States

Loading reserves the source height without flashing plain code. Streaming keeps
completed lines stable and displays the unfinished line as plain text. A failed
grammar falls back to plain source. Large blocks label the highlighting limit.
Hover and focus on header actions follow the button component. Disabled copy
uses the button's disabled state. Light and dark use the same semantic tokens.

## Usage

Syntax colours identify grammatical roles inside code only (2026-09-26). They
are content, never control accents. Use sem.syntax tokens and do not load the
highlighter in the application's initial bundle.

## Accessibility

Source stays selectable text in pre/code. Wrap is an aria-pressed toggle. Copy
has a spoken name and reports failure or success through the shared toast.
Header actions retain visible keyboard focus. No animated loading treatment.
