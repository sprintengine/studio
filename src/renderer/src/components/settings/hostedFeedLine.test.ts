import assert from 'node:assert/strict'

import type { HostedModelFeedReadResult } from '../../../../shared/electron-api'
import { hostedFeedLine } from './hostedFeedLine'

const feed = { schemaVersion: 1 as const, updatedAt: '2026-09-04T00:00:00Z', clis: {} }
const now = Date.parse('2026-09-05T12:02:00Z')
const ok = (
  source: 'network' | 'cache' | 'seed',
  state: 'ok' | 'degraded' = 'ok',
  fetchedAt = '2026-09-05T12:00:00Z',
): HostedModelFeedReadResult => ({
  ok: true,
  state,
  feedUrl: 'https://example.com/f.json',
  source,
  fetchedAt,
  changed: false,
  feed,
})

// Live, just fetched. Terse, the way the band above it says "Checked 2m ago".
assert.deepEqual(hostedFeedLine(ok('network'), now), { primary: 'Models updated 2m ago', meta: 'from GitHub' })
// A 304 or a read inside the TTL: still GitHub's copy, aged by the last contact.
assert.deepEqual(hostedFeedLine(ok('cache'), now), { primary: 'Models updated 2m ago', meta: 'from GitHub' })
// Offline with a last good copy: the time stays, the words say so.
assert.deepEqual(hostedFeedLine(ok('cache', 'degraded', '2026-09-02T12:00:00Z'), now), {
  primary: 'Models updated 3d ago',
  meta: 'offline · showing last copy',
})
// The bundled seed, before and after a failed first fetch.
assert.deepEqual(hostedFeedLine(ok('seed'), now), { primary: 'Models from this build', meta: 'GitHub not reached yet' })
assert.deepEqual(hostedFeedLine(ok('seed', 'degraded'), now), {
  primary: 'Models from this build',
  meta: "couldn't reach GitHub",
})
// Nothing read yet (the boot call has not answered) reads as the seed.
assert.deepEqual(hostedFeedLine(null, now), { primary: 'Models from this build', meta: 'GitHub not reached yet' })
// Nothing to serve at all: the reason, in the words the client chose.
assert.deepEqual(
  hostedFeedLine({ ok: false, state: 'fetch-error', feedUrl: 'x', message: 'GitHub answered HTTP 500.' }, now),
  { primary: 'Models could not be checked', meta: 'GitHub answered HTTP 500.' },
)
// The strings never leak the client's vocabulary.
for (const line of [
  hostedFeedLine(ok('network'), now),
  hostedFeedLine(ok('cache', 'degraded'), now),
  hostedFeedLine(ok('seed'), now),
]) {
  for (const word of ['etag', 'schema', 'cache', 'seed', 'network', 'degraded']) {
    assert.ok(!`${line.primary} ${line.meta}`.toLowerCase().includes(word), `${word} is not a word for the screen`)
  }
}

console.log('hosted feed line ok')
