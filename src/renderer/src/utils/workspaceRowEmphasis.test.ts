import assert from 'node:assert/strict'

import {
  WORKSPACE_ROW_QUIET_AFTER_MS,
  workspaceRowEmphasis,
  type WorkspaceRowEmphasis,
} from './workspaceRowEmphasis'

// The contrast rule for a sidebar row (contrast-for-quiet-chats, 2026-09-07).
// Two tiers and one clock: bold for every chat someone is using, dim ink for
// the ones nobody is. The sidebar owns how a tier is drawn; this owns which
// tier a row is.

const NOW = 1_800_000_000_000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

const emphasisOf = (
  overrides: Partial<Parameters<typeof workspaceRowEmphasis>[0]> = {}
): WorkspaceRowEmphasis =>
  workspaceRowEmphasis({
    selected: false,
    working: false,
    wantsYou: false,
    settled: false,
    lastActiveAt: NOW,
    now: NOW,
    ...overrides,
  })

// Everything anyone is using is one tier. There is no middle step: three
// levels of text contrast on one column is a ladder to read rather than a
// foreground to see (owner, 2026-09-07).
assert.equal(emphasisOf({ selected: true }), 'active', 'the row you are in')
assert.equal(emphasisOf({ working: true }), 'active', 'an agent mid-turn')
assert.equal(emphasisOf({ wantsYou: true }), 'active', 'a row blocked on you, or finished while you were away')
assert.equal(emphasisOf({ lastActiveAt: NOW - 22 * MINUTE }), 'active', 'touched 22 minutes ago')

assert.equal(
  emphasisOf({ selected: true, lastActiveAt: NOW - 40 * 24 * HOUR }),
  'active',
  'selecting a forty-day-old chat brings it to the front — the clock never overrules selection'
)
assert.equal(
  emphasisOf({ working: true, settled: true }),
  'active',
  'an agent that started working on a resting row is the loudest thing that can happen to it'
)
assert.equal(
  emphasisOf({ wantsYou: true, lastActiveAt: NOW - 5 * HOUR }),
  'active',
  'a waiting row never dims, however long it has been waiting — waiting IS the reason to look'
)

// The hour line decides the rest.
assert.equal(
  emphasisOf({ lastActiveAt: NOW - WORKSPACE_ROW_QUIET_AFTER_MS + 1 }),
  'active',
  'a row one millisecond inside the window is still in the foreground'
)
assert.equal(
  emphasisOf({ lastActiveAt: NOW - WORKSPACE_ROW_QUIET_AFTER_MS }),
  'quiet',
  'the threshold itself is background'
)
assert.equal(emphasisOf({ lastActiveAt: NOW - 2 * HOUR }), 'quiet', 'two hours untouched is background')
assert.equal(emphasisOf({ settled: true }), 'quiet', 'a resting row is background whatever its clock says')
assert.equal(emphasisOf({ lastActiveAt: null }), 'quiet', 'a row with no clock has no claim on the foreground')

// The dim threshold is far short of the rest threshold on purpose: dimming
// asks "is anyone using this", settling asks "is this chat over".
assert.ok(WORKSPACE_ROW_QUIET_AFTER_MS < 3 * 24 * HOUR, 'a row dims long before it settles')

console.log('ok - workspace row emphasis: bold for the chats in use, dim ink for the ones nobody is using')
