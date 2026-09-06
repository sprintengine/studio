/**
 * The card feed's service and IPC pair, and the one wire that makes them worth
 * having.
 *
 * The client has its own suite (card-feed-client.test.ts); this one covers the
 * three things nothing else can see:
 *
 *   1. `hosted-card-feed:get` asks for `cachedOnly` and never fetches. It is
 *      the first-paint path, and the Extensions home is a page of pictures that
 *      must draw before anyone has finished opening the door.
 *   2. `hosted-card-feed:changed` fires when the read changed something, and
 *      not otherwise. A read that served the same copy back is not news, and
 *      waking every window for it would make the home page redraw on a timer.
 *   3. Something in the shipped app reaches a FETCHING read. Item 2466 shipped
 *      the service, the IPC pair, the preload surface and the slice, and every
 *      caller of all four asked for the disk copy — so a machine served the
 *      bundled seed forever and a card published after install never arrived.
 *      The poller leg in app-lifecycle is what closes that, and it is asserted
 *      here because it is the only line in the app that does.
 *
 * `electron` is the seam stub: its `ipcMain.handle` records the handler and its
 * one `BrowserWindow` pushes `webContents.send` at the listeners `ipcRenderer`
 * registered, so the default broadcast is exercised rather than stood in for.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ipcMain, ipcRenderer } from 'electron'

import type { HostedCardFeedReadInput, HostedCardFeedReadResult } from '../../shared/electron-api'
import type { HostedCardFeed } from '../../shared/hosted-card-feed'
import { registerHostedCardFeedIpc } from '../ipc/card-feed-ipc'
import type { HostedCardFeedClient } from './card-feed-client'
import {
  HOSTED_CARD_FEED_CHANGED_CHANNEL,
  readHostedCardFeed,
  setHostedCardFeedClientForTests,
} from './card-feed-service'

const FEED: HostedCardFeed = { schemaVersion: 1, updatedAt: '2026-09-06T00:00:00.000Z', cards: [] }

function ok(changed: boolean): HostedCardFeedReadResult {
  return {
    ok: true,
    state: 'ok',
    feedUrl: 'https://example.invalid/cards-feed.json',
    source: 'cache',
    fetchedAt: '2026-09-06T00:00:00.000Z',
    changed,
    feed: FEED,
  }
}

/**
 * Stands in for the client and, unlike the client, refuses to be vague: a read
 * that did not say `cachedOnly` counts as a fetch, which is exactly the
 * distinction `:get` is supposed to make.
 */
function fakeClient(answer: (input: HostedCardFeedReadInput) => HostedCardFeedReadResult) {
  const reads: HostedCardFeedReadInput[] = []
  let fetches = 0
  const client = {
    async read(input: HostedCardFeedReadInput = {}): Promise<HostedCardFeedReadResult> {
      reads.push(input)
      if (input.cachedOnly !== true) fetches += 1
      return answer(input)
    },
  }
  setHostedCardFeedClientForTests(client as unknown as HostedCardFeedClient)
  return { reads, fetches: () => fetches }
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<HostedCardFeedReadResult>

function handlers(): { get: Handler; refresh: Handler } {
  const found = new Map<string, Handler>()
  const recorder = {
    handle: (channel: string, handler: Handler) => found.set(channel, handler),
  } as unknown as typeof ipcMain
  registerHostedCardFeedIpc(recorder)
  const get = found.get('hosted-card-feed:get')
  const refresh = found.get('hosted-card-feed:refresh')
  assert.ok(get && refresh, 'both channels are registered')
  return { get, refresh }
}

/** Every `hosted-card-feed:changed` the default broadcast pushed at a window. */
function watchBroadcasts(): { count: () => number; stop: () => void } {
  let count = 0
  const listener = (): void => void (count += 1)
  ipcRenderer.on(HOSTED_CARD_FEED_CHANGED_CHANNEL, listener)
  return { count: () => count, stop: () => void ipcRenderer.removeListener(HOSTED_CARD_FEED_CHANGED_CHANNEL, listener) }
}

// 1. `:get` serves the disk copy and never touches the network.
async function testGetNeverFetches(): Promise<void> {
  const client = fakeClient(() => ok(true))
  const { get } = handlers()
  const watch = watchBroadcasts()

  const result = await get(null)
  assert.equal(result.ok, true)
  assert.deepEqual(client.reads, [{ cachedOnly: true }], '`:get` asks for the disk copy and nothing else')
  assert.equal(client.fetches(), 0, '`:get` never fetches')

  // Not even when a caller passes something. The channel takes no argument on
  // purpose; a renderer that invents one must not be able to talk this handler
  // onto the network.
  await get(null, { forceRefresh: true })
  assert.deepEqual(client.reads[1], { cachedOnly: true }, 'a forceRefresh smuggled into `:get` is ignored')
  assert.equal(client.fetches(), 0)
  watch.stop()
}

// 2. The broadcast is guarded on `result.ok && result.changed` and nothing else.
async function testBroadcastGuard(): Promise<void> {
  // Changed: every window hears about it, once.
  {
    fakeClient(() => ok(true))
    const { refresh } = handlers()
    const watch = watchBroadcasts()
    await refresh(null)
    assert.equal(watch.count(), 1, 'a read that changed the feed wakes the windows exactly once')
    watch.stop()
  }
  // Unchanged: silence. This is the common case on an hourly tick, and the one
  // that would otherwise redraw the home page for no reason.
  {
    fakeClient(() => ok(false))
    const { refresh } = handlers()
    const watch = watchBroadcasts()
    await refresh(null)
    await refresh(null, { forceRefresh: true })
    assert.equal(watch.count(), 0, 'a read that changed nothing is not news')
    watch.stop()
  }
  // Failed: silence too, even though `changed` is not on the shape at all. The
  // renderer keeps the last good cards; there is nothing to push at it.
  {
    fakeClient(() => ({
      ok: false,
      state: 'offline',
      feedUrl: 'https://example.invalid/cards-feed.json',
      message: "Couldn't reach GitHub.",
    }))
    const { refresh } = handlers()
    const watch = watchBroadcasts()
    const result = await refresh(null)
    assert.equal(result.ok, false)
    assert.equal(watch.count(), 0, 'a failed read pushes nothing')
    watch.stop()
  }
  // And the guard is the service's, not the IPC layer's: a caller reaching
  // `readHostedCardFeed` straight (the poller does) gets the same rule.
  {
    fakeClient(() => ok(true))
    const watch = watchBroadcasts()
    await readHostedCardFeed()
    assert.equal(watch.count(), 1)
    watch.stop()
  }
}

// 3. Something fetches. Two halves: the service's own default read is a
//    fetching one, and the app actually calls it on the poller's feed leg.
async function testSomethingFetches(): Promise<void> {
  const client = fakeClient(() => ok(false))
  const broadcasts: HostedCardFeedReadResult[] = []
  await readHostedCardFeed({}, (result) => void broadcasts.push(result))
  assert.deepEqual(client.reads, [{}], 'the poller path reads with no `cachedOnly`')
  assert.equal(client.fetches(), 1, 'and that read is a fetching one')
  assert.equal(broadcasts.length, 0, 'the injected broadcast obeys the same guard as the default one')

  const { refresh } = handlers()
  await refresh(null, { forceRefresh: true })
  assert.deepEqual(client.reads[1], { forceRefresh: true }, '`:refresh` forwards a forced read')
  assert.equal(client.fetches(), 2)

  // The wiring itself. `app-lifecycle` cannot be imported into a node test —
  // it is the whole main process — so the one line that makes the hosted card
  // feed a hosted feed at all is pinned by reading it. Item 2466 shipped
  // without it and the seed was all a shipped machine ever saw.
  const lifecycle = await readFile(join(process.cwd(), 'src', 'main', 'app-lifecycle.ts'), 'utf8')
  const code = lifecycle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(
    /readHostedCardFeed\s*\(/.test(code),
    'app-lifecycle must call readHostedCardFeed — nothing else in the app ever fetches the card feed',
  )
  assert.ok(
    /refreshFeed:[\s\S]{0,600}?readHostedCardFeed\s*\(/.test(code),
    'and it must ride the poller’s feed leg, so the fetch happens on a schedule rather than once',
  )
}

async function main(): Promise<void> {
  await testGetNeverFetches()
  await testBroadcastGuard()
  await testSomethingFetches()
  setHostedCardFeedClientForTests(null)
  console.log('card-feed service + ipc: ok')
}

// A test that awaits a promise nobody resolves lets node exit 0 with nothing
// printed. Refuse that: the run is a pass only when main() reached its end.
let finished = false
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('card-feed service + ipc: main() did not finish')
    process.exitCode = 1
  }
})
main()
  .then(() => {
    finished = true
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
