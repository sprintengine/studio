# Attachment chip

A removable piece of context staged on a composer, shared by the launcher and conversation. Its neutral selected ground marks attached content without spending the primary action accent.

## Anatomy

- `.ds-attachment-chip`: inline wrapper, selected ground, chip radius, meta type, medium weight.
- Optional leading glyph, followed by a truncating label.
- A separate close button names the attachment it removes.
- An inspectable label can contain a chip button opening a popover; removal remains a sibling control.

## Variants

Static label or inspectable label. Skills, files, folders and images use the same shape.

## States

The wrapper does not hover or focus. The close button and optional inspect control inherit the button and chip-button states, including focus-visible and disabled behavior.

## Usage

Place attached context above the composer field. Use neutral selected ground: a staged attachment is a selection. The consuming implementation is `src/renderer/src/components/ui/AttachmentChip.tsx`.

## Accessibility

Removal is a separately focusable button labelled `Remove <attachment name>`. Never nest it inside the inspect button. A truncated static label exposes the complete text through the shared truncated-text component.
