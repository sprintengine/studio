// Part of the IPC contract: the hosted sources and card feeds.
// ../electron-api.ts re-exports everything here.

import type { HostedCardFeed } from '../hosted-card-feed'
import type { HostedSourcesFeed } from '../hosted-sources-feed'

// The hosted sources feed (src/shared/hosted-sources-feed.ts) as the
// main-process client serves it. Deliberately the card feed's shape and
// deliberately not the card feed's type, for the reason the card feed's own
// comment gives below: the schemas ship on their own clocks and a shared
// alias would make one feed's change the other's problem. A failure carries no
// list, and the surface then shows no recommendations — which is exactly what
// it showed before this feed existed, so there is nothing to apologise for.
export type HostedSourcesFeedReadInput = {
  forceRefresh?: boolean
  // Serve whatever is on disk (cache, else seed) without touching the network.
  cachedOnly?: boolean
}

export type HostedSourcesFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      changed: boolean
      feed: HostedSourcesFeed
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

// The hosted card feed (src/shared/hosted-card-feed.ts) as the main-process
// client serves it. Deliberately the sources feed's shape and deliberately not
// the sources feed's type: the two schemas ship on their own clocks and a shared
// alias would make one feed's change the other feed's problem. `ok: true`
// always carries a feed to draw — live from GitHub, the disk cache, or the
// bundled seed — because the home page never apologises for its own network
// (epic ruling R6). `dropped` counts rows this build refused inside an
// otherwise good body: a diagnostic, never a reason to blank the page.
export type HostedCardFeedReadInput = {
  forceRefresh?: boolean
  // Serve whatever is on disk (cache, else seed) without touching the network.
  // The Extensions home uses it so first paint never waits on a fetch.
  cachedOnly?: boolean
}

export type HostedCardFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      // True when this read wrote a different copy to the disk cache (the first
      // live copy after install counts, even if it equals the bundled seed).
      // Fires `hosted-card-feed:changed`; the renderer decides what to do.
      changed: boolean
      feed: HostedCardFeed
      // Rows the schema gate refused inside an otherwise good body, and what
      // was wrong with each. Reported, never fatal — and reported for a cached
      // or seeded copy too, because a build that cannot read a card the feed
      // carries should say so wherever it read it from.
      dropped?: number
      dropReasons?: string[]
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }
