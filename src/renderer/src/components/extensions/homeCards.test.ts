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
  cardActionLabel,
  CARD_KIND_STAMPS,
  cardStampLabel,
  homeCardCount,
  homeCardGrid,
  matchesHomeCardSearch,
  newHomeCardSlugs,
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

run('a card that spells `hero: false` sorts by date like one that says nothing', () => {
  // `hero` is optional, so the feed has two ways of saying "ordinary card" and
  // the comparator has to read them as one. Comparing the raw fields made
  // `false !== undefined` true, which answered "these differ" for two ordinary
  // cards and never reached the date branch at all — so the page came out in
  // feed order and nobody could see that it had. The oldest card is written
  // FIRST here on purpose: that is the pair order the broken comparator got
  // wrong, and a list already in the right order would have hidden it.
  const ordered = orderHomeCards([
    card({ slug: 'old', publishedAt: '2026-08-01T00:00:00.000Z' }),
    card({ slug: 'new', publishedAt: '2026-09-05T00:00:00.000Z', hero: false }),
    card({ slug: 'middle', publishedAt: '2026-09-02T00:00:00.000Z' }),
  ])
  assert.deepEqual(
    slugs(ordered),
    ['new', 'middle', 'old'],
    'newest first, whichever of the two ways each card declines to be the hero',
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
  assert.equal(matchesHomeCardSearch(browser, 'browser'), true, 'a card found by a word that is on it')
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
  const cards = [card({ slug: 'hero', title: 'Big task? No problem.', hero: true }), browser]
  const grid = homeCardGrid(cards, 'browser')
  assert.equal(grid.hero, null, 'the wide plate is a slot the feed assigns, not a rank the page hands out')
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
  const kinds: HostedCardKind[] = ['mcp', 'skill', 'plugin', 'automation', 'showcase']
  for (const kind of kinds) {
    const label = cardStampLabel(kind)
    assert.ok(label && label.length > 0, `${kind} has a stamp`)
    assert.equal(label, CARD_KIND_STAMPS[kind])
  }
  assert.equal(cardStampLabel('mcp'), 'MCP server', 'the product’s own words for it, not the machine’s')
})

// ── What the visit marks as new ──────────────────────────────────────────────
// The home freezes the stamp it opened on and chips every card published after
// it. The rail square's `unseenCardCount` counts the same cards, so these cases
// are also the counter's cases: a square that says "2 new" over a page wearing
// three chips is the badge lying about the page beside it.

run('no stamp is nothing new — a fresh profile is not a page of chips', () => {
  const feed = [
    card({ slug: 'a', publishedAt: '2026-09-05T00:00:00.000Z' }),
    card({ slug: 'b', publishedAt: '2026-09-06T00:00:00.000Z' }),
  ]
  assert.equal(newHomeCardSlugs(feed, undefined).size, 0, 'never looked, so nothing arrived since')
  assert.equal(newHomeCardSlugs(feed, null).size, 0, 'and null says the same thing as undefined')
  assert.equal(newHomeCardSlugs(feed, '').size, 0, 'as does an empty stamp')
})

run('a stamp this build cannot read marks nothing', () => {
  const feed = [card({ slug: 'a', publishedAt: '2026-09-05T00:00:00.000Z' })]
  assert.equal(
    newHomeCardSlugs(feed, 'last tuesday').size,
    0,
    'a bad date must not turn the whole feed new — the failure is silent and the chip would never clear',
  )
})

run('strictly after the stamp, and only that', () => {
  const seenAt = '2026-09-03T00:00:00.000Z'
  const marked = newHomeCardSlugs(
    [
      card({ slug: 'before', publishedAt: '2026-09-02T23:59:59.999Z' }),
      card({ slug: 'exactly-then', publishedAt: seenAt }),
      card({ slug: 'after', publishedAt: '2026-09-03T00:00:00.001Z' }),
    ],
    seenAt,
  )
  assert.deepEqual([...marked], ['after'], 'a card published at the stamp was on the page they just looked at')
  assert.ok(!marked.has('before'), 'and one older than it certainly was')
})

run('a card whose date cannot be read is never new', () => {
  const marked = newHomeCardSlugs(
    [
      card({ slug: 'unreadable', publishedAt: 'soon' }),
      card({ slug: 'readable', publishedAt: '2026-09-09T00:00:00.000Z' }),
    ],
    '2026-09-03T00:00:00.000Z',
  )
  assert.deepEqual([...marked], ['readable'], 'NaN is not a date after the stamp, and a chip on it would never clear')
})

run('the mark is the whole difference — it is not a hoist and not a sort key', () => {
  // `design-system/components/badge/component.md`, "The New mark": the row stays
  // exactly where its list put it, so a muscle-memory pick still lands.
  const feed = [
    card({ slug: 'old', publishedAt: '2026-08-01T00:00:00.000Z' }),
    card({ slug: 'fresh', publishedAt: '2026-09-09T00:00:00.000Z' }),
    card({ slug: 'hero', publishedAt: '2026-07-01T00:00:00.000Z', hero: true }),
  ]
  const before = slugs(orderHomeCards(feed))
  newHomeCardSlugs(feed, '2026-09-01T00:00:00.000Z')
  assert.deepEqual(slugs(orderHomeCards(feed)), before, 'asking which cards are new moves none of them')
})

console.log('homeCards.test.ts: ok')

// ── The word on the button ───────────────────────────────────────────────────
// Derived, never carried: a `cta` string on the schema would be a field in which
// a card could lie about what it is about to do, and no parser could check it.
{
  const card = (kind: HostedCardKind, go: HostedCard['go']): HostedCard => ({
    slug: 'x',
    kind,
    title: 't',
    dek: 'd',
    art: 'split',
    publishedAt: '2026-09-06',
    go,
  })
  const CHAT = { verb: 'open.chat' as const, prompt: 'p', send: true }

  // Every kind has a word, and the table is keyed on the union so a kind added
  // to the schema is a typecheck failure rather than a button with nothing in it.
  for (const kind of ['mcp', 'skill', 'plugin', 'automation', 'showcase'] as const) {
    const label = cardActionLabel(card(kind, [CHAT]))
    assert.ok(label.length > 0, `${kind}: has a word`)
    assert.notEqual(label, 'Go', `${kind}: and it is not "Go"`)
  }
  assert.equal(cardActionLabel(card('plugin', [CHAT])), 'Install', 'a plugin card offers an install')
  assert.equal(cardActionLabel(card('automation', [CHAT])), 'Create', 'an automation card creates one')

  // The ACTIONS outrank the kind: a showcase card's kind alone would say
  // "See it", and a card that only opens a door shows nothing.
  assert.equal(
    cardActionLabel(card('showcase', [{ verb: 'open.surface', view: 'skills' }])),
    'Open Skills',
    'a card that only navigates names the door, whatever its stamp claims',
  )
  // `require.cli` is a check, not a change, so it does not make a card an installer.
  assert.equal(
    cardActionLabel(
      card('mcp', [
        { verb: 'require.cli', cli: 'claude-code' },
        { verb: 'open.surface', view: 'agent-clis' },
      ]),
    ),
    'Open Agent CLIs',
    'a runtime check does not turn a navigation into an install',
  )
  // But anything that actually changes the machine does.
  assert.equal(
    cardActionLabel(
      card('mcp', [
        { verb: 'install.mcp', id: 'x' },
        { verb: 'open.surface', view: 'plugins' },
      ]),
    ),
    'Install',
    'a card that installs and then navigates is an install',
  )
}
