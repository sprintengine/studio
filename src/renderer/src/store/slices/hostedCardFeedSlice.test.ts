import assert from 'node:assert/strict'

import type { HostedCardFeedReadResult } from '../../../../shared/electron-api'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import {
  createHostedCardFeedSlice,
  subscribeHostedCardFeedChanges,
  type HostedCardFeedSliceState,
} from './hostedCardFeedSlice'

const card = (slug: string): HostedCard => ({
  slug,
  kind: 'mcp',
  title: slug,
  dek: 'A sentence.',
  art: 'browser',
  publishedAt: '2026-09-06',
  go: [],
})

const feed = (slugs: string[]) => ({
  schemaVersion: 1 as const,
  updatedAt: '2026-09-06T00:00:00Z',
  cards: slugs.map(card),
})

const okResult = (
  slugs: string[],
  source: 'network' | 'cache' | 'seed',
  changed: boolean,
): HostedCardFeedReadResult => ({
  ok: true,
  state: 'ok',
  feedUrl: 'https://example.com/cards-feed.json',
  source,
  fetchedAt: '2026-09-06T12:00:00Z',
  changed,
  feed: feed(slugs),
})

const slugsOf = (state: HostedCardFeedSliceState): string[] => state.cards.map((c) => c.slug)

async function main(): Promise<void> {
  const carrier: HostedCardFeedSliceState = { cards: [], cardFeedStatus: 'idle', cardFeedError: null }
  const calls: string[] = []
  const slice = createHostedCardFeedSlice((mutator) => mutator(carrier), {
    getApi: () => ({
      hostedCardFeedGet: async () => {
        calls.push('get')
        return okResult(['browser'], 'seed', false)
      },
    }),
  })

  // First paint serves the disk copy, and says so.
  await slice.loadCards()
  assert.deepEqual(calls, ['get'])
  assert.deepEqual(slugsOf(carrier), ['browser'])
  assert.equal(carrier.cardFeedStatus, 'ready')
  assert.equal(carrier.cardFeedError, null)

  // The push is the only other way rows arrive: there is no refresh action on
  // this slice, and a test that invented one would be the whole of its
  // audience (the seam this file's sibling comment records).
  slice.applyHostedCardFeedResult(okResult(['browser', 'design-system'], 'network', true))
  assert.deepEqual(calls, ['get'], 'the slice never fetches; main does')
  assert.deepEqual(slugsOf(carrier), ['browser', 'design-system'])

  // A failed read keeps the last good feed and records why. The page never
  // blanks because GitHub was unreachable.
  slice.applyHostedCardFeedResult({ ok: false, state: 'offline', feedUrl: 'x', message: "Couldn't reach GitHub." })
  assert.deepEqual(slugsOf(carrier), ['browser', 'design-system'])
  assert.equal(carrier.cardFeedStatus, 'error')
  assert.equal(carrier.cardFeedError, "Couldn't reach GitHub.")

  // A good read after a failure clears the error.
  slice.applyHostedCardFeedResult(okResult(['browser'], 'cache', false))
  assert.equal(carrier.cardFeedStatus, 'ready')
  assert.equal(carrier.cardFeedError, null)

  // A read that throws is a failure, not a crash, and still holds the rows.
  const throwing = createHostedCardFeedSlice((mutator) => mutator(carrier), {
    getApi: () => ({
      hostedCardFeedGet: async () => {
        throw new Error('no bridge')
      },
    }),
  })
  await throwing.loadCards()
  assert.deepEqual(slugsOf(carrier), ['browser'])
  assert.equal(carrier.cardFeedStatus, 'error')
  assert.equal(carrier.cardFeedError, 'no bridge')

  // Nothing on screen yet means loading; cards already showing means no spinner.
  const empty: HostedCardFeedSliceState = { cards: [], cardFeedStatus: 'idle', cardFeedError: null }
  let release: (() => void) | null = null
  const pending = createHostedCardFeedSlice((mutator) => mutator(empty), {
    getApi: () => ({
      hostedCardFeedGet: () =>
        new Promise<HostedCardFeedReadResult>((resolve) => {
          release = () => resolve(okResult(['browser'], 'seed', false))
        }),
    }),
  })
  const inFlight = pending.loadCards()
  assert.equal(empty.cardFeedStatus, 'loading')
  release!()
  await inFlight
  assert.equal(empty.cardFeedStatus, 'ready')
  // A re-read behind cards that are already on screen is not a spinner.
  const behind = pending.loadCards()
  assert.equal(empty.cardFeedStatus, 'ready')
  release!()
  await behind
  assert.equal(empty.cardFeedStatus, 'ready')

  // The push subscription applies whatever main sends, and detaches.
  let pushed: ((result: HostedCardFeedReadResult) => void) | null = null
  const unsubscribe = subscribeHostedCardFeedChanges(slice.applyHostedCardFeedResult, {
    onHostedCardFeedChanged: (cb) => {
      pushed = cb
      return () => {
        pushed = null
      }
    },
  })
  assert.ok(pushed)
  pushed!(okResult(['only-this'], 'network', true))
  assert.deepEqual(slugsOf(carrier), ['only-this'])
  unsubscribe()
  assert.equal(pushed, null)

  // No api (a test renderer, a detached tool window) is a quiet no-op.
  const bare = createHostedCardFeedSlice((mutator) => mutator(carrier), { getApi: () => null })
  await bare.loadCards()
  assert.deepEqual(slugsOf(carrier), ['only-this'])
  assert.equal(subscribeHostedCardFeedChanges(() => {}, null)(), undefined)

  console.log('hostedCardFeedSlice: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
