import assert from 'node:assert/strict'
import { test } from 'vitest'

import { terminalResumeFromQuery } from './tailnet/tailnet-terminal-stream'

const query = (search: string) => new URLSearchParams(search)

test('an attach naming a stream and a position resumes from it', () => {
  assert.deepEqual(terminalResumeFromQuery(query('sessionId=s&stream=stream-a&after=1024')), {
    stream: 'stream-a',
    position: 1024,
  })
  assert.deepEqual(terminalResumeFromQuery(query('stream=stream-a&after=0')), { stream: 'stream-a', position: 0 })
})

test('an attach naming no position is a fresh attach', () => {
  assert.equal(terminalResumeFromQuery(query('sessionId=s')), undefined)
  assert.equal(terminalResumeFromQuery(query('stream=stream-a')), undefined)
  assert.equal(terminalResumeFromQuery(query('after=12')), undefined)
})

// The worst a bad resume point may cost is a repaint, so anything unreadable is
// no resume at all rather than a refusal.
test('a malformed resume point is ignored, never refused', () => {
  for (const after of ['-1', '1.5', '1e3', 'abc', '', '9999999999999999999']) {
    assert.equal(terminalResumeFromQuery(query(`stream=stream-a&after=${encodeURIComponent(after)}`)), undefined, after)
  }
  assert.equal(terminalResumeFromQuery(query(`stream=${'s'.repeat(65)}&after=1`)), undefined)
})
