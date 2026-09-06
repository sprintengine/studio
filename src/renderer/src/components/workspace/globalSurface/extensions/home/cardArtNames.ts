// The names of the artwork this build ships — the list itself, with no JSX
// anywhere near it.
//
// It lives apart from `cardArt.tsx` for one reason. The seed gate
// (`scripts/check-card-feed-seed.mjs`) has to know which names resolve before it
// can say whether a bundled card's `art` field names a picture, and a node
// script cannot read a file full of plates. So it bundles THIS module with
// esbuild, the same trick it already uses for the feed parser, and checks the
// seed against the registry's own list rather than against a second copy typed
// out in the script. A second copy would drift from the first the day somebody
// added a plate, and drift is the whole thing the gate exists to catch — a gate
// that introduces the failure it guards against is worse than no gate.
//
// `cardArt.tsx` re-exports both of these, so nothing in the renderer needs to
// import from here.

/**
 * Every artwork name this build holds, in the order the mockups introduce them.
 * A card naming anything else is not rendered (`renderableCards.ts`).
 */
export const CARD_ART_NAMES = [
  'browser',
  'city',
  'split',
  'board',
  'tokens',
  'braces',
  'plane',
  'clock',
  'graph',
  'spark',
] as const

/** Artwork this build ships. A card naming anything else does not render. */
export type CardArtName = (typeof CARD_ART_NAMES)[number]
