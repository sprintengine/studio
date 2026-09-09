import assert from 'node:assert/strict'

import { workspaceRowEmphasis, type WorkspaceRowEmphasis } from './workspaceRowEmphasis'

// The contrast rule for a sidebar row (contrast-for-quiet-chats, 2026-09-07;
// the clock struck out and residency put in its place, 2026-09-09). Two tiers
// and no clock: bold for the chats with an agent in them, dim ink for the
// records. The sidebar owns how a tier is drawn; this owns which tier a row is.

const emphasisOf = (
  overrides: Partial<Parameters<typeof workspaceRowEmphasis>[0]> = {}
): WorkspaceRowEmphasis =>
  workspaceRowEmphasis({
    resident: false,
    selected: false,
    working: false,
    wantsYou: false,
    ...overrides,
  })

// Everything anyone is using is one tier. There is no middle step: three
// levels of text contrast on one column is a ladder to read rather than a
// foreground to see (owner, 2026-09-07).
assert.equal(emphasisOf({ resident: true }), 'active', 'an agent alive in the chat')
assert.equal(emphasisOf({ selected: true }), 'active', 'the row you are in')
assert.equal(emphasisOf({ working: true }), 'active', 'an agent mid-turn')
assert.equal(emphasisOf({ wantsYou: true }), 'active', 'a row blocked on you, or finished while you were away')

// The line that decides the rest: no agent left in the chat. Nothing a row can
// say about WHEN it last moved brings it back to the foreground.
assert.equal(
  emphasisOf(),
  'quiet',
  'a chat with no agent in it is background, however recently it was touched'
)
assert.equal(
  emphasisOf({ resident: false, selected: true }),
  'active',
  'selecting an agentless chat still brings it to the front — residency never overrules selection'
)
assert.equal(
  emphasisOf({ resident: false, wantsYou: true }),
  'active',
  'a chat whose agent finished and exited still carries its unseen mark — being asked for outlives the session'
)

console.log('ok - workspace row emphasis: bold for the chats with an agent in them, dim ink for the rest')
