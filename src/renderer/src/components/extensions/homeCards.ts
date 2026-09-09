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

import type { CardSurfaceView, HostedCard, HostedCardKind } from '../../../../shared/hosted-card-feed'
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
 * The word on a card's button, by what the card offers.
 *
 * Every card said **Go** until 2026-09-06, and that was a misreading of ruling
 * R4. "Go goes" is about CEREMONY — no consent screen, no plan, no progress
 * modal, no "are you sure" — and it was taken as the button's name, so twelve
 * different offers wore one label.
 *
 * The button matters more here than on an ordinary surface, because the card is
 * an advert (R2): a claim in one line, no step list, and deliberately no summary
 * of the actions. So the button is the ENTIRE disclosure. "Go" on a card about to
 * clone a repository, install a plugin and start an agent says nothing; "Install"
 * says most of it in one word without becoming the recipe R2 forbids.
 *
 * Derived, never carried. A `cta` string on the schema would be a field in which
 * a card could lie about what it is about to do, and no parser could check it.
 */
const CARD_KIND_ACTIONS: Readonly<Record<HostedCardKind, string>> = {
  mcp: 'Install',
  skill: 'Install',
  plugin: 'Install',
  workflow: 'Start',
  sprint: 'Start',
  automation: 'Create',
  showcase: 'See it',
}

/** A door's name, as a person reads it — the noun that follows "Open". */
const CARD_SURFACE_NAMES: Readonly<Record<CardSurfaceView, string>> = {
  home: 'Extensions',
  plugins: 'Plugins',
  skills: 'Skills',
  'agent-clis': 'Agent CLIs',
  workflows: 'Workflows',
  sprints: 'Sprints',
}

/**
 * Does this card CHANGE anything, or does it only move you somewhere?
 *
 * `require.cli` is a check rather than a change, so a card that verifies a
 * runtime and then opens a door still only navigates. Everything else in the
 * vocabulary installs, clones or starts an agent.
 */
function navigatesOnly(card: HostedCard): CardSurfaceView | null {
  let view: CardSurfaceView | null = null
  for (const action of card.go) {
    if (action.verb === 'open.surface') {
      view ??= action.view
      continue
    }
    if (action.verb === 'require.cli') continue
    return null
  }
  return view
}

/**
 * The label for this card's one control.
 *
 * The card's ACTIONS outrank its `kind`, and the shipped hero is why. Its kind is
 * `workflow`, so the kind alone would label it "Start" — and it starts nothing;
 * it opens a door. A card whose actions only navigate has to say so whatever its
 * stamp claims, which is also what stops the button and the stamp saying the same
 * noun twice.
 *
 * Keyed on the union, so a kind added to the schema is a typecheck failure here
 * rather than a button with no word in it — the same discipline `CARD_KIND_STAMPS`
 * already keeps.
 */
export function cardActionLabel(card: HostedCard): string {
  const view = navigatesOnly(card)
  return view ? `Open ${CARD_SURFACE_NAMES[view]}` : CARD_KIND_ACTIONS[card.kind]
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
    // `Boolean(...)`, not the raw fields. `hero` is OPTIONAL on the schema, so a
    // card that writes `hero: false` and a card that says nothing at all are two
    // different values for one meaning — and `false !== undefined` is true, which
    // made the comparator answer "these differ" for two ordinary cards and skip
    // the date branch entirely. The feed then came out in whatever order it
    // arrived in rather than newest first, silently, on a page where the order
    // IS the editorial decision. Comparing the meaning rather than the value is
    // also what makes this a total order, which is the only kind `sort` promises
    // anything about.
    if (Boolean(left.hero) !== Boolean(right.hero)) return left.hero ? -1 : 1
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

/**
 * The cards the home marks with the New chip: everything published strictly
 * after the stamp the visit was opened with.
 *
 * Never seen is nothing new — a fresh install, before the host has stamped its
 * first ready feed — because a page that chipped its whole feed on the first
 * open would be marking the product rather than what arrived. A stamp this
 * build cannot parse is treated the same way, for the same reason: a bad date
 * must not turn every card new.
 *
 * The rule is stated once, here. `unseenCardCount` in `utils/railBadges.ts`
 * counts the same cards for the rail square and has to AGREE with this set — a
 * square saying "2 new" over a page wearing three chips is the badge lying —
 * so that counter delegates to this function rather than restating the rule.
 */
export function newHomeCardSlugs(
  cards: readonly HostedCard[],
  seenAt: string | null | undefined,
): ReadonlySet<string> {
  const slugs = new Set<string>()
  if (!seenAt) return slugs
  const seenMs = Date.parse(seenAt)
  if (Number.isNaN(seenMs)) return slugs
  // Only what this build can draw: a card whose artwork it does not ship is
  // not on the page, so counting it would badge the square for a chip nobody
  // can ever see (review, 2026-09-09).
  for (const card of renderableCards(cards)) {
    const publishedMs = Date.parse(card.publishedAt)
    // Strictly after. A card published at the very millisecond of the stamp was
    // on the page the person just looked at, so it is not news to them; and a
    // date this build cannot read is never new, because the alternative is a
    // chip that never clears.
    if (!Number.isNaN(publishedMs) && publishedMs > seenMs) slugs.add(card.slug)
  }
  return slugs
}

// Epoch millis, or 0 for a date this build cannot read — which sorts such a
// card to the bottom instead of poisoning every comparison it takes part in.
function publishedAtMs(card: HostedCard): number {
  const parsed = Date.parse(card.publishedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}
