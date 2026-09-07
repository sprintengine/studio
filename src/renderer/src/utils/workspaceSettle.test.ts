import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  WORKSPACE_AUTO_SETTLE_AFTER_MS,
  decideWorkspaceSettlement,
  isSettledWorkspace,
  settleWorkspacePatch,
  shouldAutoSettleWorkspace,
  wakeWorkspacePatch,
  workspaceLastActiveAt,
} from './workspaceSettle'

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

// Only the fields the rules read; cast at the test boundary keeps the
// fixtures readable without an `any`.
function ws(fields: Partial<Workspace>): Workspace {
  return {
    id: 'w',
    name: 'w',
    mode: 'standard',
    createdAt: NOW - 10 * DAY,
    lastTerminalActivityAt: null,
    sprintEngineState: null,
    sprintEngineAutoState: {},
    ...fields,
  } as unknown as Workspace
}

// One predicate for "resting".
assert.equal(isSettledWorkspace(ws({})), false, 'a fresh row is not settled')
assert.equal(isSettledWorkspace(ws({ settledAt: NOW })), true, 'settledAt rests')
assert.equal(isSettledWorkspace(ws({ settledAt: null })), false, 'an explicit null is not a stamp')

// Last activity is the whole chat going quiet: the person's last work OR the
// agent's last turn end, whichever is later.
assert.equal(workspaceLastActiveAt(ws({})), NOW - 10 * DAY, 'creation when nothing else')
assert.equal(
  workspaceLastActiveAt(ws({ lastTerminalActivityAt: NOW - 2 * DAY, lastTurnEndedAt: NOW - 5 * DAY })),
  NOW - 2 * DAY,
  'typing later than the turn end wins'
)
assert.equal(
  workspaceLastActiveAt(ws({ lastTerminalActivityAt: NOW - 5 * DAY, lastTurnEndedAt: NOW - DAY })),
  NOW - DAY,
  'a turn that ended after the last keystroke counts as activity'
)

// The 3-day idle rule, measured from last activity.
assert.equal(shouldAutoSettleWorkspace(ws({}), NOW), true, 'idle 10 days settles')
assert.equal(shouldAutoSettleWorkspace(ws({ lastTerminalActivityAt: NOW - DAY }), NOW), false, 'typed yesterday stays')
assert.equal(shouldAutoSettleWorkspace(ws({ lastTurnEndedAt: NOW - DAY }), NOW), false, 'an agent that finished yesterday stays')
assert.equal(
  shouldAutoSettleWorkspace(ws({ createdAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS + 1 }), NOW),
  false,
  'just inside the window stays'
)
assert.equal(
  shouldAutoSettleWorkspace(ws({ createdAt: NOW - WORKSPACE_AUTO_SETTLE_AFTER_MS }), NOW),
  true,
  'exactly at the threshold settles'
)

// Exempt for good: already resting, a hand decision, starred, remote-born, the hosts.
assert.equal(shouldAutoSettleWorkspace(ws({ settledAt: NOW - DAY }), NOW), false, 'never re-settle')
assert.equal(shouldAutoSettleWorkspace(ws({ settledOverride: 'active' }), NOW), false, 'a manual Un-settle holds the row active')
assert.equal(shouldAutoSettleWorkspace(ws({ settledOverride: 'settled' }), NOW), false, "a manual Settle is not the sweep's to touch")
assert.equal(
  shouldAutoSettleWorkspace(ws({ highlight: { starred: true, color: null } }), NOW),
  false,
  'starred never settles'
)
assert.equal(
  shouldAutoSettleWorkspace(ws({ remoteOrigin: { connectionId: 'c', machineName: 'm' } as unknown as Workspace['remoteOrigin'] }), NOW),
  false,
  "a row born on a paired machine is the Remote band's, not the sweep's"
)
assert.equal(
  shouldAutoSettleWorkspace(ws({ mode: 'automations-host' as Workspace['mode'] }), NOW),
  false,
  'automations host never settles'
)
assert.equal(
  shouldAutoSettleWorkspace(ws({ mode: 'reviews-host' as Workspace['mode'] }), NOW),
  false,
  'reviews host never settles'
)

// Sprints with pending work never settle; finished merged runs do.
const sprintState = (tasks: { status: string }[], vcs?: { pullRequestState: string }) =>
  ({ tasks, vcs } as unknown as Workspace['sprintEngineState'])
assert.equal(
  shouldAutoSettleWorkspace(
    ws({ mode: 'sprintengine' as Workspace['mode'], sprintEngineState: sprintState([{ status: 'in_progress' }]) }),
    NOW
  ),
  false,
  'in-progress sprint never settles'
)
assert.equal(
  shouldAutoSettleWorkspace(
    ws({
      mode: 'sprintengine' as Workspace['mode'],
      sprintEngineState: sprintState([{ status: 'done' }], { pullRequestState: 'open' }),
    }),
    NOW
  ),
  false,
  'finished-but-unmerged sprint never settles'
)
assert.equal(
  shouldAutoSettleWorkspace(
    ws({
      mode: 'sprintengine' as Workspace['mode'],
      sprintEngineState: sprintState([{ status: 'done' }], { pullRequestState: 'merged' }),
    }),
    NOW
  ),
  true,
  'merged sprint settles once idle'
)

// The sweep's decision, given what only the caller knows.
const decide = (workspace: Workspace, flags: { active?: boolean; busy?: boolean; held?: boolean } = {}) =>
  decideWorkspaceSettlement({
    workspace,
    now: NOW,
    active: flags.active ?? false,
    busy: flags.busy ?? false,
    held: flags.held ?? false,
  })
assert.equal(decide(ws({})), 'settle', 'a quiet idle row settles')
assert.equal(decide(ws({}), { active: true }), 'none', 'the row someone is looking at is never settled under them')
assert.equal(decide(ws({}), { busy: true }), 'none', 'a busy row is not idle, whatever the clock says')
assert.equal(decide(ws({}), { held: true }), 'none', 'a row wearing the unseen finished mark is not settled away')
assert.equal(decide(ws({ lastTerminalActivityAt: NOW - DAY })), 'none', 'a recent row is left alone')
assert.equal(decide(ws({ settledAt: NOW - DAY })), 'none', 'a resting quiet row keeps resting')
assert.equal(decide(ws({ settledAt: NOW - DAY }), { active: true }), 'none', 'reading a settled row does not wake it')
assert.equal(decide(ws({ settledAt: NOW - DAY }), { busy: true }), 'wake', 'a resting row that is busy again wakes')
assert.equal(
  decide(ws({ settledAt: NOW - DAY, settledOverride: 'settled' }), { busy: true }),
  'wake',
  'activity wakes even a hand-settled row — new activity resumes the usual rules'
)
assert.equal(
  decide(ws({ settledAt: NOW - DAY, settledOverride: 'settled' }), { held: true }),
  'none',
  'the unseen mark is a thing to look at, not activity: it never undoes a hand Settle'
)
assert.equal(decide(ws({ settledOverride: 'active' })), 'none', 'a hand Un-settle holds against the sweep')

// The two transitions as field patches. A rest decision carries the input
// clock so main is never behind the decision; a wake clears the stamp and
// sets (or spends) the hand decision.
assert.deepEqual(
  settleWorkspacePatch(ws({ lastTerminalActivityAt: NOW - 5 * DAY }), NOW, 'settled'),
  { settledAt: NOW, settledOverride: 'settled', lastTerminalActivityAt: NOW - 5 * DAY }
)
assert.deepEqual(
  settleWorkspacePatch(ws({}), NOW, null),
  { settledAt: NOW, settledOverride: null },
  'no input clock, no clock in the patch (absent is "no opinion")'
)
assert.deepEqual(wakeWorkspacePatch('active'), { settledAt: null, settledOverride: 'active' })
assert.deepEqual(wakeWorkspacePatch(null), { settledAt: null, settledOverride: null })

console.log('workspaceSettle tests passed')
