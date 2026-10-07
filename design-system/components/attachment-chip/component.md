# Attachment chip

A removable piece of context staged on a composer, shared by the launcher and conversation. Its neutral selected ground marks attached content without spending the primary action accent.

## Anatomy

- `.ds-attachment-chip`: inline wrapper, selected ground, chip radius, meta type, medium weight.
- Optional leading glyph, followed by a truncating label.
- A separate close button names the attachment it removes.
- An inspectable label can contain a chip button opening a popover; removal remains a sibling control.
- The file card (`.ds-attachment-chip--file`) is one button, `.ds-attachment-chip-file-open`: a preview square the height of an image thumbnail (`.ds-attachment-chip-file-preview`, the operating system's thumbnail of the file or its file-type glyph), then a caption of the name, cut in the middle so its extension survives, over the type in micro text (`.ds-attachment-chip-file-type`: PDF, DOCX, XLSX, Folder). The close button is pinned to the card's top-right corner.

## Variants

Static label or inspectable label. Skills, @-mentioned files and folders use the same shape.

**File card.** A file attached by path — dropped, picked or pasted from the system — is a card, not a chip: it has something to show and something to do. The card shows the file (a thumbnail where the system draws one, the type glyph until then and wherever it does not) and opens it in the app the system picks for it. Only a kind of file that is shown rather than run opens that way — a document, plain text or data, a picture, a recording; anything else (a program, a script, a shortcut, an archive, a file with no extension) is only revealed in its folder, so the same click shows it in Finder or Explorer instead. A sent message shows its files as the same cards, without the close button; in a chat on another machine, whose files this computer cannot open, they are badges with each file's name.

## States

The wrapper does not hover or focus. The close button and optional inspect control inherit the button and chip-button states, including focus-visible and disabled behavior.

## Usage

Place attached context above the composer field. File cards share the image thumbnails' strip and row height; the consuming implementation is `AttachmentFileCard` in the same file, wired to the file by `ComposerFileChip`. Use neutral selected ground: a staged attachment is a selection. The consuming implementation is `src/renderer/src/components/ui/AttachmentChip.tsx`.

## Accessibility

Removal is a separately focusable button labelled `Remove <attachment name>`. A file card's button is labelled with what it does — `Open <name>`, or `Reveal in Finder: <name>` where the file is only revealed — and its context menu (the pointer's secondary click, or the keyboard's menu key) offers Open and Reveal in Finder / Show in Explorer. Never nest it inside the inspect button. A truncated static label exposes the complete text through the shared truncated-text component.
