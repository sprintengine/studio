# Principles

The rules of this system that tokens alone cannot carry. Read before designing
anything new.

## Do

- One accent per view. Selection and the primary action share
  `sem.color.accent.primary`; everything else is neutral ink.
- Structure with hairline borders (`sem.color.border.default`), not shadows or
  cards-on-cards.
- Status colors mean status. `sem.color.status.danger` marks destruction and
  failure — never a category, never decoration.
- Keep rhythm coarse: at most three font sizes and two corner radii per view.
- Sentence case everywhere. No uppercase-tracking chrome.

## Don't (AI-tell anti-patterns)

- No blue-shifted dark surfaces (`#0a0d18`-family hues). The dark scale here is
  warm ink; blue-tinted darks are the single strongest generated-UI tell.
- No purple-to-blue gradient CTAs, glassmorphism panels, or glow shadows.
- No inventing intermediate tokens. If a value is missing, add it to
  `tokens.tokens.json` with semantics — never hard-code it in component CSS.
- No second accent. If a design "needs" two accents, the hierarchy is wrong.

## Voice

Copy is calm, specific, and short. Buttons name the action ("Save draft"), not
enthusiasm ("Let's go!").
