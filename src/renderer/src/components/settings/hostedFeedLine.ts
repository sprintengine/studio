// The words on the Settings › Agent CLIs feed line (backlog/2026-09-04-hosted-
// update-and-model-feed.md, S6): what the model list is showing and where it
// came from, in the three states the mockup draws — live, cached, this build —
// plus the one where nothing could be served. Pure: the panel hands in the last
// read and the clock, this hands back two strings and the test holds the table.
// Plain words only; the client's source/state names never reach the screen.
import type { HostedModelFeedReadResult } from '../../../../shared/electron-api'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

export type HostedFeedLine = {
  // "Models updated 2m ago" (the band's terse form) / "Models from this build".
  primary: string
  // "from GitHub" / "offline · showing last copy" / "GitHub not reached yet".
  meta: string
}

export function hostedFeedLine(result: HostedModelFeedReadResult | null, now: number): HostedFeedLine {
  if (!result) return { primary: 'Models from this build', meta: 'GitHub not reached yet' }
  if (!result.ok) return { primary: 'Models could not be checked', meta: result.message }
  if (result.source === 'seed') {
    return {
      primary: 'Models from this build',
      meta: result.state === 'degraded' ? "couldn't reach GitHub" : 'GitHub not reached yet',
    }
  }
  const when = formatRelativeMsAgo(Date.parse(result.fetchedAt), now)
  return {
    primary: when ? `Models updated ${when}` : 'Models updated',
    meta: result.state === 'degraded' ? 'offline · showing last copy' : 'from GitHub',
  }
}
