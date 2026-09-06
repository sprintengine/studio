// The filter that enforces the no-artwork-no-card ruling.
//
// The owner ruled it on 2026-09-06, and it is the reason this module exists at
// all: **a card whose artwork this build does not have is not rendered, and it
// does not fall back to a grey rectangle with a word on it.** The splash IS the
// card — a home page of grey rectangles teaches nobody anything and would be
// worse than the catalogue it replaced — so the correct trade is fewer and
// better, and the feed is allowed to open with three
// (`2026-09-06-card-splashes.html`, Frame 3).
//
// This is the one place the ruling is applied to a list. Everything downstream
// may assume that every card it holds has a plate, which is what lets the
// renderer take `CARD_ART[card.art]` without a fallback branch that would
// quietly reintroduce the grey rectangle.
//
// It is also the place a card from the future lands. The feed ships daily and
// the app ships on release, so an old build will meet a card naming artwork it
// has never heard of; that is expected, it is not an error, and it is not
// something the page apologises for (epic ruling R6). The card simply is not
// there.
//
// Pure and DOM-free, so the ordering and the dropping are tested without a
// renderer.

import type { HostedCard } from '../../../../../../../shared/hosted-card-feed'
import { hasCardArt } from './cardArt'

/**
 * The cards this build can actually draw, in the order they arrived.
 *
 * The input array is returned unchanged when nothing is dropped, which is the
 * common case: the home page memoises on this result, and allocating a fresh
 * array every render would defeat every memo downstream of it and repaint the
 * grid on each keystroke elsewhere in the app. A copy is made only when there
 * is genuinely something to leave out.
 */
export function renderableCards(cards: readonly HostedCard[]): readonly HostedCard[] {
  const firstUnknown = cards.findIndex((card) => !hasCardArt(card.art))
  if (firstUnknown === -1) return cards
  return cards.filter((card) => hasCardArt(card.art))
}
