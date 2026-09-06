import assert from 'node:assert/strict'

// What the Extensions home does with the feed, asserted without a renderer —
// the shape `extensionsHomeTiles.test.ts` beside it already has, and for the
// same reason: the ordering, the hero rule and the search are decisions, and a
// decision proved by reading pixels out of a mounted page is a decision proved
// twice as slowly and half as clearly.
//
// The three rulings under test are the module's own: a card whose artwork this
// build does not have is not rendered (2026-09-06); the hero is the card the
// FEED promoted, never a position the page hands out; and the search runs over
// the words a person can see on the card and nothing else.

import type { HostedCard, HostedCardKind } from '../../../../shared/hosted-card-feed'
import { CARD_ART_NAMES } from '../workspace/globalSurface/extensions/home/cardArtNames'
import {
  CARD_KIND_STAMPS,
  cardStampLabel,
  homeCardCount,
  homeCardGrid,
  matchesHomeCardSearch,
  orderHomeCards,
} from './homeCards'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const card = (over: Partial<HostedCard> & { slug: string }): HostedCard => ({
  kind: 'showcase',
  title: 'A capability, in the second person',
  dek: 'What it does, in a sentence somebody outside the team can read.',
  art: 'browser',
  publishedAt: '2026-09-01T00:00:00.000Z',
  go: [],
  ...over,
})

const slugs = (cards: readonly HostedCard[]): string[] => cards.map((entry) => entry.slug)

// ── Order ────────────────────────────────────────────────────────────────────

run('the hero leads, and everything after it is newest first', () => {
  const ordered = orderHomeCards([
    card({ slug: 'old', publishedAt: '2026-08-01T00:00:00.000Z' }),
    card({ slug: 'new', publishedAt: '2026-09-05T00:00:00.000Z' }),
    card({ slug: 'hero', publishedAt: '2026-07-01T00:00:00.000Z', hero: true }),
    card({ slug: 'middle', publishedAt: '2026-09-02T00:00:00.000Z' }),
  ])
  assert.deepEqual(
    slugs(ordered),
    ['hero', 'new', 'middle', 'old'],
    'the hero leads however old it is — it is the feed’s promotion, not the newest row',
  )
})

run('two cards published on the same day keep the feed’s own order', () => {
  const sameDay = '2026-09-03T00:00:00.000Z'
  const ordered = orderHomeCards([
    card({ slug: 'first', publishedAt: sameDay }),
    card({ slug: 'second', publishedAt: sameDay }),
  ])
  assert.deepEqual(
    slugs(ordered),
    ['first', 'second'],
    'the feed is authored by hand, so the order two same-day cards arrive in is an editorial decision, not noise',
  )
})

run('a second hero is an ordinary card', () => {
  const grid = homeCardGrid([
    card({ slug: 'later', publishedAt: '2026-09-04T00:00:00.000Z', hero: true }),
    card({ slug: 'earlier', publishedAt: '2026-09-01T00:00:00.000Z', hero: true }),
  ])
  assert.equal(grid.hero?.slug, 'later', 'the newest of the flagged cards leads')
  assert.deepEqual(slugs(grid.rest), ['earlier'], 'and the other takes an ordinary 16:9 slot')
})

run('a card whose artwork this build does not have is not there at all', () => {
  const cards = [
    card({ slug: 'known', art: CARD_ART_NAMES[0] }),
    card({ slug: 'from-the-future', art: 'artwork-a-later-release-ships', hero: true }),
  ]
  assert.deepEqual(
    slugs(orderHomeCards(cards)),
    ['known'],
    'the no-artwork-no-card ruling is composed in here, so the page cannot forget to ask',
  )
  assert.equal(homeCardCount(cards), 1)
  assert.equal(
    homeCardGrid(cards).hero,
    null,
    'and a hero this build cannot draw does not drag another card into the wide plate',
  )
})

// ── Search ───────────────────────────────────────────────────────────────────

const browser = card({
  slug: 'browser',
  title: 'Let an agent drive your browser',
  dek: 'Describe the journey in words and it clicks through your app.',
  credit: 'Playwright',
})

run('the search reads the title, the dek and the credit', () => {
  assert.equal(matchesHomeCardSearch(browser, 'drive'), true, 'the title')
  assert.equal(matchesHomeCardSearch(browser, 'journey'), true, 'the dek')
  assert.equal(matchesHomeCardSearch(browser, 'playwright'), true, 'the credit, case and all')
  assert.equal(
    matchesHomeCardSearch(browser, 'browser'),
    true,
    'a card found by a word that is on it',
  )
})

run('and nothing else on the card', () => {
  const hidden = card({
    slug: 'telegram-bot',
    kind: 'mcp',
    title: 'Put an agent in your chat',
    dek: 'Answer from the bus.',
    go: [{ verb: 'install.mcp', id: 'io-github-telegram' }],
  })
  assert.equal(
    matchesHomeCardSearch(hidden, 'telegram'),
    false,
    'the slug and the install plan are not words on the card — a match hiding in either reads as a bug',
  )
})

run('every term has to land, and an empty search matches everything', () => {
  assert.equal(matchesHomeCardSearch(browser, 'agent browser'), true, 'two words a person remembers')
  assert.equal(matchesHomeCardSearch(browser, 'agent unreal'), false, 'one of which is not here')
  assert.equal(matchesHomeCardSearch(browser, ''), true)
  assert.equal(matchesHomeCardSearch(browser, '   '), true, 'whitespace is not a filter')
})

run('a card with no credit is still searchable, and does not match nothing', () => {
  const uncredited = card({ slug: 'quiet', title: 'A showcase', dek: 'Something to look at.' })
  assert.equal(matchesHomeCardSearch(uncredited, 'showcase'), true)
  assert.equal(matchesHomeCardSearch(uncredited, 'undefined'), false, 'an absent credit is absent, not the word')
})

// ── The grid ─────────────────────────────────────────────────────────────────

run('a search that leaves the hero out promotes nobody in its place', () => {
  const cards = [
    card({ slug: 'hero', title: 'Big task? No problem.', hero: true }),
    browser,
  ]
  const grid = homeCardGrid(cards, 'browser')
  assert.equal(
    grid.hero,
    null,
    'the wide plate is a slot the feed assigns, not a rank the page hands out',
  )
  assert.deepEqual(slugs(grid.rest), ['browser'])
})

run('a feed with no hero at all is a page of even cards', () => {
  const grid = homeCardGrid([card({ slug: 'a' }), card({ slug: 'b' })])
  assert.equal(grid.hero, null)
  assert.deepEqual(slugs(grid.rest), ['a', 'b'])
})

run('an empty feed is an empty grid, and says nothing about why', () => {
  const grid = homeCardGrid([])
  assert.equal(grid.hero, null)
  assert.deepEqual(slugs(grid.rest), [])
  assert.equal(homeCardCount([]), 0)
})

// ── The stamp ────────────────────────────────────────────────────────────────

run('every kind the schema knows has a word on its stamp', () => {
  const kinds: HostedCardKind[] = ['mcp', 'skill', 'plugin', 'workflow', 'sprint', 'automation', 'showcase']
  for (const kind of kinds) {
    const label = cardStampLabel(kind)
    assert.ok(label && label.length > 0, `${kind} has a stamp`)
    assert.equal(label, CARD_KIND_STAMPS[kind])
  }
  assert.equal(cardStampLabel('mcp'), 'MCP server', 'the product’s own words for it, not the machine’s')
})

console.log('homeCards.test.ts: ok')
