# Creation-surface backdrops

Per-theme editorial backplates for the app's *creation / empty / first-run*
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

Theme ids come from `src/renderer/src/types/appTheme.ts`. Source images: 16:9,
1672 × 941, resized to max 1600 px wide, re-encoded JPEG q82. Built so the art's
palette agrees with the theme's `--accent-primary` and surface ramp.

## Generation spec

Per theme, both plates share ONE palette (center / edge / accent). Only the
medium differs: the workspace plate is structured paper-craft ("assembling a
system"); the chat plate is organic botanical ("a thread begins"). Center ≈ the
theme's `--bg-app`; reserve ~66% width × 62% height as a quiet near-uniform
stage; push all composition to the edges; accent used as a single restrained pop.

Exclude text, numbers, UI, logos, emblem-like forms, people, animals, insects,
butterflies, watermarks. Exclude blue and purple EXCEPT where the palette below
is itself cool/violet (slate, caramel, tokyo-night, aubergine, rose-pine,
ayu-mirage) — there the hue is the point.

| Theme | Scheme | Center | Edge palette | Accent | Workspace plate | Chat plate |
|---|---|---|---|---|---|---|
| `light` | light | `#eaeef2` | `#ffffff` `#d9dec9` `#c4cdbb` `#b9c2cc` | `#2f6a4a` | Light torn modular paper, nested apertures | Single green vine through pale paper channels |
| `paper` | light | `#f4f1e8` | `#fbf9f2` `#d9dec9` `#c4b89a` `#9bb39a` | `#2f6a4a` | Warm cream torn-paper assembly, brass pins | Pressed botanical sprigs on warm cream |
| `vellum` | light | `#e8e0d0` | `#f4ece0` `#d8c8a8` `#c8a878` `#a89060` | `#b04428` | Layered parchment + vellum apertures | Dried pressed flowers & seed heads |
| `dark` | dark | `#08080c` | `#14181c` `#28302c` `#3a4a42` `#6f5a3c` | `#3f9468` | Dark torn-paper assembly | Deep foliage on warm near-black |
| `herbarium` | light | `#d4dcc0` | `#f4ece0` `#c4cca8` `#a8b488` `#8a9a6a` | `#b04428` | Sage paper modules, pressed-leaf labels | Full pressed-herbarium specimens |
| `herbarium-dark` | dark | `#181c14` | `#242820` `#2c3424` `#44503c` `#6b7a5c` | `#d4dcc0` | Dark paper modules, sage accents | Pale specimens glowing on near-black |
| `verdigris` | dark | `#0c100c` | `#142018` `#1c2c20` `#2c4a38` `#5a6b4a` | `#c05038` | Dark-green paper-craft, copper eyelets | Deep ferns & ivy around a near-black pool |
| `conifer` | dark | `#141814` | `#20241c` `#2c3424` `#3a4a30` `#586848` | `#c8a458` | Muted sage paper modules, amber thread | Conifer boughs & needles, amber light |
| `fernery` | dark | `#142414` | `#243424` `#2c4028` `#3a5236` `#5a7048` | `#cc5838` | Mid-green paper strips, woven | Lush unfurling ferns |
| `sage` | dark | `#20241c` | `#303428` `#3c4434` `#4e5842` `#6e7a5c` | `#c85838` | Gray-green paper toolkit, terracotta clip | Dried sage bunches / muted foliage |
| `greenhouse` | dark | `#1c2418` | `#302c20` `#3c4430` `#4a5a3c` `#6b7a52` | `#c85838` | Sage paper apertures, warm card insets | Potted plants under glasshouse iron |
| `caramel` | dark | `#181408` | `#2a2010` `#4a3820` `#6e5230` `#8a6a3c` | `#5c7cfc` | Warm kraft paper toolkit, stencils, blue clip | Climbing vine on kraft / warm dried stems |
| `lantern` | dark | `#181408` | `#242018` `#3a2e18` `#5a4626` `#8a6a34` | `#e8a850` | Warm amber paper modules (no cool tones) | Candle-lit dried wheat & amber stems |
| `gruvbox` | dark | `#1c1c18` | `#282824` `#3c3834` `#5a5040` `#8a6e3c` | `#fcb04c` | Retro sepia kraft assembly | Sepia dried botanical / autumn leaves |
| `ayu-mirage` | dark | `#1c2030` | `#242838` `#303a4a` `#44506a` `#5a6a86` | `#fccc6c` | Blue-grey paper joined by golden thread & eyelets | Blue-grey foliage with golden-lit edges |
| `slate` | dark | `#202020` | `#2c2c30` `#3a3a40` `#4a4a52` `#5a5a64` | `#5c7cfc` | Cool-grey modular paper, blue routed lines | Muted grey-green foliage, cool light |
| `tokyo-night` | dark | `#181824` | `#24283c` `#2c3450` `#3a4668` `#4a5878` | `#7cb4fc` | Indigo paper-craft, blue thread network | Moonlit blue foliage / night ferns |
| `aubergine` | dark | `#14141c` | `#242430` `#32324a` `#4a4664` `#5e5a7c` | `#8c7cfc` | Plum/mauve paper modules | Dried lavender & violet stems |
| `rose-pine` | dark | `#181420` | `#241c34` `#34284a` `#4a3a5c` `#6e5a72` | `#d488a0` | Mauve paper apertures, rose thread | Dried roses & soft florals |

## Status

Finished examples to color-match against: `dark` and `paper` (both plates each).
Remaining 17 themes × 2 plates to be generated against the spec above.
