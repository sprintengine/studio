// What the Extensions home DOES with the card feed: which cards it shows, in
// which order, which one leads, and what a search over them means.
//
// A leaf beside `extensionsHomeTiles.ts`, and for the same reason: no React, no
// store, no IPC. The page reads `cards` off the store and hands them here, and
// what comes back is the grid it draws — so the ordering, the hero rule and the
// filter are all testable without mounting a page or standing up a feed.
//
// Three rulings are encoded below, and none of them is the renderer's own
// invention.
//
//   A card whose artwork this build does not have is not rendered (owner
//   ruling, 2026-09-06). That is `renderableCards` from item 2467, composed in
//   here rather than restated, so the page cannot forget to ask. An old build
//   meeting a card from a newer feed simply does not show it, and does not say
//   so — the page never reports on its own network (epic ruling R6).
//
//   The hero is a card's own claim, not a position. `HostedCard.hero` is the
//   feed's word for "the full-bleed one at the top", and the schema allows more
//   than one because "which of them leads is the renderer's business"
//   (src/shared/hosted-card-feed.ts). This is that business: the newest card
//   flying the flag leads, every other one takes an ordinary 16:9 slot. A feed
//   with no hero at all is a page of even cards, which is a smaller thing to be
//   than a page that promoted an arbitrary row to a 2.7:1 plate it was never
//   shot for.
//
//   Search is the person's own question, so it is answered over the words a
//   person can actually see: the title, the dek and the credit line. Not the
//   slug, not the kind, and not the action verbs — a card found by a string
//   that is nowhere on it reads as a bug, and a card missed because the match
//   was hiding in its install plan reads as a worse one.

import type { HostedCard, HostedCardKind } from '../../../../shared/hosted-card-feed'
import { renderableCards } from '../workspace/globalSurface/extensions/home/renderableCards'

/**
 * The word on a card's stamp, top right of its splash.
 *
 * The feed carries a `kind` — a machine word from a closed set — and this is
 * the one place it becomes English. "MCP server" is two words because that is
 * what the product calls it everywhere else; the rest are the noun with a
 * capital letter, because a stamp is a label and not a sentence.
 *
 * Keyed by the union rather than looked up loosely, so a kind added to the
 * schema fails the typecheck here instead of drawing an empty pill.
 */
export const CARD_KIND_STAMPS: Readonly<Record<HostedCardKind, string>> = {
  mcp: 'MCP server',
  skill: 'Skill',
  plugin: 'Plugin',
  workflow: 'Workflow',
  sprint: 'Sprint',
  automation: 'Automation',
  showcase: 'Showcase',
}

/** The stamp for a card, by its kind. */
export function cardStampLabel(kind: HostedCardKind): string {
  return CARD_KIND_STAMPS[kind]
}

/**
 * The cards this build can draw, in the order the page draws them: the ones the
 * feed marked `hero` first, then everything else newest first.
 *
 * `publishedAt` has already been validated as a date by the feed parser, so an
 * unparsable one cannot arrive here through the store — the guard below is for
 * the caller that builds a card by hand, and it sorts such a card last rather
 * than letting `NaN` decide the whole comparison.
 *
 * Ties keep the feed's own order. `Array.prototype.sort` has been stable since
 * ES2019, and the feed is authored by hand in one repository, so the order two
 * cards published on the same day arrive in is a real editorial decision and
 * not noise to be re-shuffled.
 */
export function orderHomeCards(cards: readonly HostedCard[]): readonly HostedCard[] {
  return [...renderableCards(cards)].sort((left, right) => {
    if (left.hero !== right.hero) return left.hero ? -1 : 1
    return publishedAtMs(right) - publishedAtMs(left)
  })
}

/**
 * Does this card answer the search? Every whitespace-separated term has to
 * appear somewhere in the title, the dek or the credit, case-insensitively.
 *
 * Terms rather than the raw string, so "browser agent" finds a card that says
 * "Let an agent drive your browser" — a person typing two words is naming two
 * things they remember, not quoting a sentence. An empty or whitespace-only
 * query matches everything, which is what makes the unfiltered page and the
 * filtered one the same code path.
 */
export function matchesHomeCardSearch(card: HostedCard, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${card.title}\n${card.dek}\n${card.credit ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * The grid the page draws: the one card that leads, and the rest in two
 * columns.
 *
 * The hero survives the filter like any other card. A search that leaves the
 * hero out promotes nobody in its place — the remaining cards are all ordinary
 * cards, and the wide plate is a slot the feed assigns rather than a rank the
 * page hands out. `hero` is null in that case, and the page draws two columns
 * from the top.
 */
export type HomeCardGrid = {
  hero: HostedCard | null
  rest: readonly HostedCard[]
}

export function homeCardGrid(cards: readonly HostedCard[], query = ''): HomeCardGrid {
  const visible = orderHomeCards(cards).filter((card) => matchesHomeCardSearch(card, query))
  const [first, ...others] = visible
  return first?.hero ? { hero: first, rest: others } : { hero: null, rest: visible }
}

/**
 * How many cards this build would draw for the feed as it stands, ignoring any
 * search. The page asks it to decide whether there is a card region at all: a
 * feed that yields nothing falls back to the tiles alone, with no apology and
 * no notice (epic ruling R6).
 */
export function homeCardCount(cards: readonly HostedCard[]): number {
  return renderableCards(cards).length
}

// Epoch millis, or 0 for a date this build cannot read — which sorts such a
// card to the bottom instead of poisoning every comparison it takes part in.
function publishedAtMs(card: HostedCard): number {
  const parsed = Date.parse(card.publishedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}
