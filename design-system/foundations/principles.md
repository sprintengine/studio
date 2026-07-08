# Principles

Extracted from the Multicode app's documented design language
(`knowledge/brand/` and `src/renderer/src/assets/index.css` in the source
product). These are the source's de-facto rules restated for this bundle;
each is a proposal until confirmed in review.

## One accent

- One accent hue per view: the signature green (`sem.color.accent.primary`).
  Active selection and primary action share it; hover lifts to `accent.hover`.
- Boxed selection is a 2px left bar of `accent.primary` over an
  `accent.soft` fill — never a full accent-filled row.
- Status colors are not accents: never use `sem.color.status.*` as button
  backgrounds, section borders, chrome tints, or category coding.

## Hairlines carry the structure

- Borders do the structural work. Cards, badges, and shadows do not.
- The only drop shadow is `sem.shadow.drawer`, on drawers and overlay panels.
- Hover is a background change (`sem.color.bg.hover`) only — no shadow, no
  scale, no glow.

## Coarse, deliberate scales

- The surface ramp (`bg.app` → `bg.selected`) is intentionally coarse; do not
  invent intermediate steps or blue-shifted variants.
- At most 2 border radii per view; `radius.control` (5px) is the default,
  larger radii belong to overlays and modal shells only.
- At most 3 text sizes per view; the rhythm repeats title / body / meta.

## Type

- Inter for UI, JetBrains Mono for identifiers, code, and `kbd`.
- Sentence case everywhere except keyboard shortcuts. No uppercase-tracking
  chrome.
- Tabular numerals on every numeric column; identifiers use mono at
  `font.size.meta` in `text.subtle`.

## Status is earned

- Status reads by shape first, color second — every state must survive
  grayscale. Done/healthy items render no mark by default.
- Only genuinely live work animates (a single spinner or pulsing dot);
  nothing ambient.
- The accent green (forest) and the success green (bright emerald) are kept
  apart by brightness and saturation; do not retune one toward the other.

## Motion is rare and earned

- One easing curve (`motion.ease.standard`), three durations. Hover/focus at
  `fast`, popovers at `normal`, drawers at `deliberate`.
- Every animation honors `prefers-reduced-motion: reduce`.
- Never put `backdrop-filter` on a full-viewport scrim; separation comes from
  the scrim tone plus the drawer shadow.

## Modes

- Light and dark ship from the same semantic tokens; consumers style with
  `--sem-*` only and never write per-mode overrides.
- Contrast floors are load-bearing: body text clears AA on its surface;
  `text.subtle` and `text.disabled` never carry actionable copy alone.
- Dark-mode values keep the source's anti-dither discipline (solid channel
  values on multiples of 4, no pure black surfaces).

## Tokens or nothing

- Never hard-code a color. Every color resolves from a `--sem-*` variable;
  pick tokens by their documented role and use, not by their looks.
