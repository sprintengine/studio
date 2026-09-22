// Whether a scheduled run publishes a nightly. The schedule ticks every thirty
// minutes so a batch of merges never waits long once the interval has passed,
// but a tick publishes only when both hold:
//
//   - at least six hours since the last published nightly, so an installed
//     nightly is offered a few builds a day rather than one per merge; and
//   - main has commits the last nightly did not ship, so a quiet day publishes
//     nothing.
//
// Pure: the caller lists the releases, asks GitHub for the comparison and
// passes a clock, so every branch is covered offline by nightly-gate.test.mjs.
// A dispatched nightly skips this gate entirely.

import { channelForVersion, sourceShaFromBody } from './release-lib.mjs'

export const NIGHTLY_INTERVAL_MS = 6 * 60 * 60 * 1000

function isNightly(release) {
  try {
    return channelForVersion(release.tag_name) === 'nightly'
  } catch {
    return false
  }
}

// The newest published nightly by publish time, not by version: its version is
// what the next stable would be, and a stable promoted in between resets that.
export function lastNightly(releases) {
  return (
    releases
      .filter((release) => !release.draft && release.published_at && isNightly(release))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] ?? null
  )
}

// `comparison` is GitHub's compare of the last nightly's commit against main's
// head (`{ status }`), or null when there is nothing to compare against: the
// nightly does not record its commit, or GitHub no longer has that commit.
// Only "ahead" means main has something new. "identical" is the same commit,
// and "behind" or "diverged" means main was rewritten under the nightly, which
// a scheduled tick should report rather than paper over by publishing.
export function nightlyGate({ releases, comparison, now, intervalMs = NIGHTLY_INTERVAL_MS }) {
  const last = lastNightly(releases)
  if (!last) return { publish: true, reason: 'No nightly has been published yet.' }

  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const elapsed = nowMs - Date.parse(last.published_at)
  if (elapsed < intervalMs) {
    const hours = (Math.max(0, elapsed) / 3_600_000).toFixed(1)
    return {
      publish: false,
      reason: `${last.tag_name} was published ${hours} hours ago; nightlies are at least ${intervalMs / 3_600_000} hours apart.`,
    }
  }

  if (!sourceShaFromBody(last.body) || !comparison) {
    return { publish: true, reason: `${last.tag_name} cannot be compared with main, so main is treated as new.` }
  }
  if (comparison.status !== 'ahead') {
    return { publish: false, reason: `main is ${comparison.status} relative to ${last.tag_name}; nothing new to ship.` }
  }
  return { publish: true, reason: `main has commits since ${last.tag_name}.` }
}
