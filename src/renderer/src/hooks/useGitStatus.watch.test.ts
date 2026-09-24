import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gitStatusWatchRefreshDelay, shouldIgnoreGitStatusWatchEvent } from './useGitStatus'

// Regression: main used to coalesce any two watch events inside 100 ms into
// `{ path: null }`, and this hook read a null path as "ignore". A save that
// landed in the same burst as a `node_modules` write — or as a second save —
// never refreshed git status.

test('a real edit in a burst with dependency churn refreshes status', () => {
  assert.equal(
    shouldIgnoreGitStatusWatchEvent({
      path: 'node_modules/a/index.js',
      paths: ['node_modules/a/index.js', 'src/app.ts'],
    }),
    false,
  )
})

test('a burst main could not list is a possible edit, not noise', () => {
  assert.equal(shouldIgnoreGitStatusWatchEvent({ path: null }), false, 'the old coalesced shape')
  assert.equal(shouldIgnoreGitStatusWatchEvent({ path: null, paths: [], overflow: true }), false)
})

test('a burst of only ignored paths is still skipped', () => {
  assert.equal(
    shouldIgnoreGitStatusWatchEvent({ path: '.git/index', paths: ['.git/index', 'node_modules/x/y.js', 'dist/a.js'] }),
    true,
  )
})

test('an edit inside the minimum interval is deferred to its end, never dropped', () => {
  const last = 1_000_000
  assert.equal(gitStatusWatchRefreshDelay(last + 60_000, last), 1_000, 'outside the window: the plain debounce')
  assert.equal(gitStatusWatchRefreshDelay(last + 2_000, last), 8_000, 'inside it: runs when the window closes')
  assert.equal(gitStatusWatchRefreshDelay(last + 9_900, last), 1_000, 'never sooner than the debounce')
})
