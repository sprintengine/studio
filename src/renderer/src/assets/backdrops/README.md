# Creation-surface backdrops

Per-theme editorial backplates for the app's _creation / empty / first-run_
moments only — never behind live operational chrome (a backdrop behind working
chrome reads as clutter; the chat plate fades out the moment the first message
arrives). Each image is a framing composition with a deliberately quiet center,
so a card or composer sits in the calm middle while the art lives at the edges.
Pair with a soft center scrim so the foreground keeps WCAG AA contrast and
remains the clear visual priority.

## File convention

Two plates per theme, keyed off the active `data-theme` on `<html>`:

    backdrop-<theme-id>-workspace.jpg   structured / paper-craft — behind NewWorkspacePanel
    backdrop-<theme-id>-chat.jpg        organic / botanical      — behind AgentChatView empty state
    4k/backdrop-<theme-id>-*.jpg        matching 3840 × 2160 derivatives

Theme ids come from `src/renderer/src/types/appTheme.ts`. Standard images are
16:9 at 1600 × 900. The `4k/` set is 3840 × 2160, produced with Lanczos scaling,
light luma sharpening, and JPEG q3. `CreationBackdrop` exposes both through
`srcset`, allowing Chromium to choose a display-appropriate asset. The art's
palette agrees with the theme's `--accent-primary` and surface ramp.

## Generation spec

Per theme, both plates share ONE palette (center / edge / accent). Only the
medium differs: the workspace plate is structured paper-craft ("assembling a
system"); the chat plate is organic botanical ("a thread begins"). Center ≈ the
theme's `--bg-app`; reserve ~66% width × 62% height as a quiet near-uniform
stage; push all composition to the edges; accent used as a single restrained pop.

Exclude text, numbers, UI, logos, emblem-like forms, people, animals, insects,
butterflies, watermarks. Exclude blue and purple EXCEPT where the palette below
is itself cool/violet (slate, tokyo-night, rose-pine) — there the hue is the
point.

| Theme            | Scheme | Center    | Edge palette                            | Accent    | Workspace plate                                   | Chat plate                                    |
| ---------------- | ------ | --------- | --------------------------------------- | --------- | ------------------------------------------------- | --------------------------------------------- |
| `light`          | light  | `#eaeef2` | `#ffffff` `#d9dec9` `#c4cdbb` `#b9c2cc` | `#2f6a4a` | Light torn modular paper, nested apertures        | Single green vine through pale paper channels |
| `paper`          | light  | `#f4f1e8` | `#fbf9f2` `#d9dec9` `#c4b89a` `#9bb39a` | `#2f6a4a` | Warm cream torn-paper assembly, brass pins        | Pressed botanical sprigs on warm cream        |
| `vellum`         | light  | `#e8e0d0` | `#f4ece0` `#d8c8a8` `#c8a878` `#a89060` | `#b04428` | Layered parchment + vellum apertures              | Dried pressed flowers & seed heads            |
| `dark`           | dark   | `#08080c` | `#14181c` `#28302c` `#3a4a42` `#6f5a3c` | `#3f9468` | Dark torn-paper assembly                          | Deep foliage on warm near-black               |
| `herbarium`      | light  | `#d4dcc0` | `#f4ece0` `#c4cca8` `#a8b488` `#8a9a6a` | `#b04428` | Sage paper modules, pressed-leaf labels           | Full pressed-herbarium specimens              |
| `herbarium-dark` | dark   | `#181c14` | `#242820` `#2c3424` `#44503c` `#6b7a5c` | `#d4dcc0` | Dark paper modules, sage accents                  | Pale specimens glowing on near-black          |
| `sage`           | dark   | `#20241c` | `#303428` `#3c4434` `#4e5842` `#6e7a5c` | `#c85838` | Gray-green paper toolkit, terracotta clip         | Dried sage bunches / muted foliage            |
| `lantern`        | dark   | `#181408` | `#242018` `#3a2e18` `#5a4626` `#8a6a34` | `#e8a850` | Warm amber paper modules (no cool tones)          | Candle-lit dried wheat & amber stems          |
| `slate`          | dark   | `#202020` | `#2c2c30` `#3a3a40` `#4a4a52` `#5a5a64` | `#5c7cfc` | Cool-grey modular paper, blue routed lines        | Muted grey-green foliage, cool light          |
| `tokyo-night`    | dark   | `#181824` | `#24283c` `#2c3450` `#3a4668` `#4a5878` | `#7cb4fc` | Indigo paper-craft, blue thread network           | Moonlit blue foliage / night ferns            |
| `rose-pine`      | dark   | `#181420` | `#241c34` `#34284a` `#4a3a5c` `#6e5a72` | `#d488a0` | Mauve paper apertures, rose thread                | Dried roses & soft florals                    |

## Status

Complete: all 19 concrete themes have both plates at standard and 4K resolution
(76 JPEGs total). `system` does not have separate files because it resolves to
the active light or dark theme before a backdrop is selected.

The full set is mirrored for visual review in
`multicode-website/public/art/multicode-theme-backdrops-2026-06/`.
