import assert from 'node:assert/strict'
import {
  computeHotWorkspaceIds,
  DEFAULT_ABSOLUTE_IDLE_CEILING_MS,
  DEFAULT_SUSPEND_IDLE_AFTER_MS,
  isSessionReapable,
  selectReapableSessions,
  type ReapCandidate,
} from './terminal-reap-policy'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_700_000_000_000
const STALE = NOW - DEFAULT_SUSPEND_IDLE_AFTER_MS - 60_000 // comfortably past the idle threshold
// Comfortably past the absolute ceiling (and therefore the idle threshold too).
const PAST_CEILING = NOW - DEFAULT_ABSOLUTE_IDLE_CEILING_MS - 60_000

// A candidate that passes every gate. Tests flip one field at a time to prove
// each gate independently keeps a terminal alive. Note: the policy is driven
// ONLY by repaint-immune signals (real interaction, visibility, run-state) — no
// activity/output gate — so a reveal repaint can never keep an agent alive.
function reapable(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-cold',
    kind: 'agent',
    cli: 'claude-code',
    visible: false,
    processAlive: true,
    lastInteractionAt: STALE,
    inActiveRun: false,
    ...overrides,
  }
}

const HOT_NONE = new Set<string>()
const POLICY = {
  now: NOW,
  idleThresholdMs: DEFAULT_SUSPEND_IDLE_AFTER_MS,
  absoluteIdleCeilingMs: DEFAULT_ABSOLUTE_IDLE_CEILING_MS,
}

run('any idle agent cli is reapable — the policy no longer gates on cli', () => {
  // The reaper acts on any idle agent regardless of CLI; only kind/visibility/
  // run-state/idle/hot-set decide. Codex (and any other agent cli) is now in.
  for (const cli of ['claude-code', 'codex', 'some-future-cli', null]) {
    assert.equal(
      isSessionReapable(reapable({ cli }), HOT_NONE, POLICY),
      true,
      `expected reapable regardless of cli: ${cli ?? 'null'}`,
    )
  }
})

run('a cold, resumable agent with no recent user input is reapable', () => {
  assert.equal(isSessionReapable(reapable(), HOT_NONE, POLICY), true)
})

run('each safety gate independently keeps the terminal alive', () => {
  const cases: Array<[string, Partial<ReapCandidate>]> = [
    ['dead process', { processAlive: false }],
    ['plain shell (not agent)', { kind: 'terminal' }],
    ['visible on screen', { visible: true }],
    ['in active managed run', { inActiveRun: true }],
    ['null workspace', { workspaceId: null }],
    ['interacted within the idle threshold', { lastInteractionAt: NOW - 1000 }],
  ]
  for (const [label, override] of cases) {
    assert.equal(
      isSessionReapable(reapable(override), HOT_NONE, POLICY),
      false,
      `expected NOT reapable: ${label}`
    )
  }
})

run('a workspace in the hot set is kept resident within the absolute ceiling', () => {
  // STALE is past the idle threshold but within the ceiling, so hot-set
  // protection still holds.
  const hot = new Set(['ws-cold'])
  assert.equal(isSessionReapable(reapable({ lastInteractionAt: STALE }), hot, POLICY), false)
})

run('a hot workspace IS reaped once idle passes the absolute ceiling', () => {
  const hot = new Set(['ws-cold'])
  assert.equal(isSessionReapable(reapable({ lastInteractionAt: PAST_CEILING }), hot, POLICY), true)
})

run('the absolute ceiling never overrides the inActiveRun (managed-run) exemption', () => {
  const hot = new Set(['ws-cold'])
  assert.equal(
    isSessionReapable(reapable({ inActiveRun: true, lastInteractionAt: PAST_CEILING }), hot, POLICY),
    false,
  )
})

run('every hard safety gate still holds past the absolute ceiling', () => {
  const hot = new Set(['ws-cold'])
  const cases: Array<[string, Partial<ReapCandidate>]> = [
    ['dead process', { processAlive: false }],
    ['plain shell (not agent)', { kind: 'terminal' }],
    ['visible on screen', { visible: true }],
    ['null workspace', { workspaceId: null }],
  ]
  for (const [label, override] of cases) {
    assert.equal(
      isSessionReapable(reapable({ ...override, lastInteractionAt: PAST_CEILING }), hot, POLICY),
      false,
      `expected NOT reapable past ceiling: ${label}`,
    )
  }
})

run('the idle clock is interaction-based: only lastInteractionAt matters', () => {
  // Past threshold by interaction → reapable; recent interaction → kept. There
  // is no output/activity term, so a repaint (which never updates interaction)
  // cannot reset this.
  assert.equal(isSessionReapable(reapable({ lastInteractionAt: STALE }), HOT_NONE, POLICY), true)
  assert.equal(isSessionReapable(reapable({ lastInteractionAt: NOW - 5_000 }), HOT_NONE, POLICY), false)
})

run('computeHotWorkspaceIds ranks by freshest interaction and respects the limit', () => {
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'a', workspaceId: 'ws-1', lastInteractionAt: NOW - 5000 }),
    reapable({ sessionId: 'b', workspaceId: 'ws-2', lastInteractionAt: NOW - 1000 }),
    reapable({ sessionId: 'c', workspaceId: 'ws-2', lastInteractionAt: NOW - 9000 }), // older sibling
    reapable({ sessionId: 'd', workspaceId: 'ws-3', lastInteractionAt: NOW - 8000 }),
  ]
  assert.deepEqual(computeHotWorkspaceIds(candidates, 2), ['ws-2', 'ws-1'])
  assert.deepEqual(computeHotWorkspaceIds(candidates, 5), ['ws-2', 'ws-1', 'ws-3'])
  assert.deepEqual(computeHotWorkspaceIds(candidates, 0), [])
})

run('computeHotWorkspaceIds ignores dead and null-workspace sessions', () => {
  const candidates: ReapCandidate[] = [
    reapable({ workspaceId: 'ws-dead', processAlive: false, lastInteractionAt: NOW }),
    reapable({ workspaceId: null, lastInteractionAt: NOW }),
    reapable({ workspaceId: 'ws-live', lastInteractionAt: NOW - 5000 }),
  ]
  assert.deepEqual(computeHotWorkspaceIds(candidates, 5), ['ws-live'])
})

run('selectReapableSessions keeps hot/visible/run-active resident and reaps the cold overflow', () => {
  const candidates: ReapCandidate[] = [
    // Hot: most recently interacted, on screen — never reaped.
    reapable({ sessionId: 'hot', workspaceId: 'ws-hot', visible: true, lastInteractionAt: NOW }),
    // Cold, no recent input — reaped.
    reapable({ sessionId: 'cold-idle', workspaceId: 'ws-cold', lastInteractionAt: STALE }),
    // Cold but in an active managed run — kept.
    reapable({ sessionId: 'cold-run', workspaceId: 'ws-run', inActiveRun: true, lastInteractionAt: STALE }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, hotWorkspaceLimit: 1 })
  assert.deepEqual(decision.reapableSessionIds, ['cold-idle'])
  // ws-hot is freshest, so it owns the single hot slot.
  assert.deepEqual(decision.hotWorkspaceIds, ['ws-hot'])
})

run('default idle threshold is applied when not overridden', () => {
  const justUnder = reapable({ sessionId: 'under', lastInteractionAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS - 1000) })
  const justOver = reapable({ sessionId: 'over', lastInteractionAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS + 1000) })
  const decision = selectReapableSessions([justUnder, justOver], { now: NOW, hotWorkspaceLimit: 0 })
  assert.deepEqual(decision.reapableSessionIds, ['over'])
})

run('selectReapableSessions reaps a hot workspace idle past the absolute ceiling', () => {
  const candidates: ReapCandidate[] = [
    // Fresh interaction — owns a hot slot, kept.
    reapable({ sessionId: 'hot-fresh', workspaceId: 'ws-fresh', lastInteractionAt: NOW }),
    // Also fits in the hot set, but idle past the ceiling — reaped anyway.
    reapable({ sessionId: 'hot-stale', workspaceId: 'ws-stale', lastInteractionAt: PAST_CEILING }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, hotWorkspaceLimit: 5 })
  assert.deepEqual(decision.reapableSessionIds, ['hot-stale'])
  // Both are ranked into the hot set; the ceiling, not hot-set membership,
  // decides reaping for the stale one.
  assert.deepEqual(decision.hotWorkspaceIds, ['ws-fresh', 'ws-stale'])
})

run('default absolute ceiling is applied when not overridden', () => {
  const justUnder = reapable({
    sessionId: 'under',
    workspaceId: 'ws-under',
    lastInteractionAt: NOW - (DEFAULT_ABSOLUTE_IDLE_CEILING_MS - 1000),
  })
  const justOver = reapable({
    sessionId: 'over',
    workspaceId: 'ws-over',
    lastInteractionAt: NOW - (DEFAULT_ABSOLUTE_IDLE_CEILING_MS + 1000),
  })
  // hotWorkspaceLimit is large enough that both workspaces are "hot"; only the
  // one past the ceiling is reaped, proving the default ceiling is enforced.
  const decision = selectReapableSessions([justUnder, justOver], { now: NOW, hotWorkspaceLimit: 5 })
  assert.deepEqual(decision.reapableSessionIds, ['over'])
})

console.log('terminal-reap-policy tests passed')
