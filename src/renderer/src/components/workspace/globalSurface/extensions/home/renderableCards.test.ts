import assert from 'node:assert/strict'

import type { HostedCard } from '../../../../../../../shared/hosted-card-feed'
import { CARD_ART, CARD_ART_NAMES, hasCardArt } from './cardArt'
import { renderableCards } from './renderableCards'

// The owner ruled on 2026-09-06 that a card whose artwork this build does not
// have is not rendered and does not fall back to a grey rectangle. These are
// the two halves of that: the registry answers whether a name resolves, and the
// filter drops the cards whose names do not.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const card = (over: Partial<HostedCard> & { slug: string; art: string }): HostedCard => ({
  kind: 'showcase',
  title: 'A capability, in the second person',
  dek: 'What it does, in a sentence somebody outside the team can read.',
  publishedAt: '2026-09-06T00:00:00.000Z',
  go: [],
  ...over,
})

run('every name the registry publishes resolves to a plate', () => {
  // Read from the list the seed gate reads, rather than restated here: a second
  // copy would go stale the day a plate was added, and this is the assertion
  // that would have to notice.
  for (const name of CARD_ART_NAMES) {
    assert.equal(hasCardArt(name), true, `${name} is published by the registry and must resolve`)
  }
  assert.equal(
    Object.keys(CARD_ART).length,
    CARD_ART_NAMES.length,
    'the registry holds a plate for every published name and nothing besides',
  )
})

run('a name this build does not hold does not resolve', () => {
  assert.equal(hasCardArt('nope'), false)
  assert.equal(hasCardArt(''), false, 'an empty name is not artwork')
})

run('a property every object has is not artwork', () => {
  // The registry is looked up by a string that came off the network, so the
  // lookup must not answer for `toString`, `constructor` or `__proto__`.
  assert.equal(hasCardArt('toString'), false)
  assert.equal(hasCardArt('constructor'), false)
  assert.equal(hasCardArt('__proto__'), false)
})

run('every registered name has a plate to draw', () => {
  for (const [name, plate] of Object.entries(CARD_ART)) {
    assert.equal(typeof plate, 'function', `${name} must resolve to a component`)
  }
})

run('a card whose artwork is unknown is dropped and the rest are kept in order', () => {
  const cards = [
    card({ slug: 'browse', art: 'browser' }),
    card({ slug: 'future', art: 'holodeck' }),
    card({ slug: 'town', art: 'city' }),
  ]
  assert.deepEqual(
    renderableCards(cards).map((row) => row.slug),
    ['browse', 'town'],
    'the unknown card goes; the known ones keep the order the feed gave them',
  )
})

run('a list with nothing to drop is the very same array', () => {
  // Not merely equal — identical. The home page memoises on this result, so a
  // fresh array on every render would defeat every memo downstream of it.
  const cards = [card({ slug: 'browse', art: 'browser' }), card({ slug: 'town', art: 'city' })]
  assert.equal(renderableCards(cards), cards)
})

run('an empty list is returned as it came', () => {
  const cards: HostedCard[] = []
  assert.equal(renderableCards(cards), cards)
})

run('a feed of nothing this build can draw renders nothing', () => {
  const cards = [card({ slug: 'a', art: 'holodeck' }), card({ slug: 'b', art: 'https://example.com/x.png' })]
  assert.deepEqual(renderableCards(cards), [], 'no card falls back to a grey rectangle')
})

console.log('card art: ok')
