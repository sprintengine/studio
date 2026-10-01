# Inline diff

## Anatomy

A filename, added/removed counts and a unified hunk view. Each line reserves a
prefix column; plus/minus characters carry meaning without colour. Hunk headings
carry old/new coordinates. A trailing action opens the full diff viewer.

## Variants

Unified only. New files show added lines and initially reveal at most forty.
Large changes show a bounded preview and retain access to the full viewer.

## States

Added and removed lines use semantic diff ink over a soft semantic status ground.
Changed words use the stronger changed token. Unchanged context stays neutral.
Highlighting errors preserve plain source. Open action uses the button focus,
hover and disabled states. Light and dark inherit semantic tokens.

## Usage

Embed in an expanded file-edit tool, never load a full editor into a transcript.
Use three context lines. Showing a diff never applies it.

## Accessibility

Source is selectable text. Prefixes communicate changes independently of colour.
Open action is keyboard reachable, named for the file, and retains visible focus.
