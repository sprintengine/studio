import assert from 'node:assert/strict'
import { test } from 'node:test'

import { lastNightly, nightlyGate } from './nightly-gate.mjs'

const SHA = 'a'.repeat(40)
const HOUR = 3_600_000
const NOW = Date.parse('2026-09-23T12:00:00Z')

function release(tag, hoursAgo, { sha = SHA, draft = false } = {}) {
  return {
    tag_name: tag,
    draft,
    published_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    body: sha ? `Nightly.\n\n<!-- source-sha: ${sha} -->\n` : 'No marker.',
  }
}

test('the first nightly publishes whatever main holds', () => {
  const gate = nightlyGate({ releases: [release('v0.5.1', 30)], comparison: null, now: NOW })
  assert.equal(gate.publish, true)
  assert.match(gate.reason, /No nightly/)
})

test('a nightly younger than six hours holds the next one back, even with new commits', () => {
  const releases = [release('v0.5.2-nightly.20260923.40', 5.9)]
  const gate = nightlyGate({ releases, comparison: { status: 'ahead' }, now: NOW })
  assert.equal(gate.publish, false)
  assert.match(gate.reason, /5\.9 hours ago/)
})

test('six hours on, a nightly publishes only when main is ahead of the commit it shipped', () => {
  const releases = [release('v0.5.2-nightly.20260923.40', 6)]
  assert.equal(nightlyGate({ releases, comparison: { status: 'ahead' }, now: NOW }).publish, true)
  assert.equal(nightlyGate({ releases, comparison: { status: 'identical' }, now: NOW }).publish, false)
  assert.equal(nightlyGate({ releases, comparison: { status: 'behind' }, now: NOW }).publish, false)
  assert.match(nightlyGate({ releases, comparison: { status: 'diverged' }, now: NOW }).reason, /diverged/)
})

test('a nightly that cannot be compared with main does not stall the train', () => {
  const unrecorded = [release('v0.5.2-nightly.20260923.40', 7, { sha: null })]
  assert.equal(nightlyGate({ releases: unrecorded, comparison: { status: 'identical' }, now: NOW }).publish, true)
  const vanished = [release('v0.5.2-nightly.20260923.40', 7)]
  assert.equal(nightlyGate({ releases: vanished, comparison: null, now: new Date(NOW) }).publish, true)
})

test('the last nightly is the newest published one, not a stable, a draft or the highest version', () => {
  const releases = [
    release('v0.5.2', 1),
    release('v0.5.3-nightly.20260923.44', 0.5, { draft: true }),
    release('v0.6.0-nightly.20260922.30', 20),
    release('v0.5.3-nightly.20260923.41', 2),
    release('v0.4.0-preview.20260919.2', 0.1),
  ]
  assert.equal(lastNightly(releases).tag_name, 'v0.5.3-nightly.20260923.41')
  assert.equal(nightlyGate({ releases, comparison: { status: 'ahead' }, now: NOW }).publish, false)
  assert.equal(lastNightly([release('v0.5.2', 1)]), null)
})
