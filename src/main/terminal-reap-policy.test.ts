import assert from 'node:assert/strict'
import {
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

// A candidate that passes every gate: an at-rest ('idle') agent that has not
// been interacted with for longer than the idle threshold. Tests flip one field
// at a time to prove each gate independently keeps a terminal alive.
function reapable(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-cold',
    kind: 'agent',
    cli: 'claude-code',
    processAlive: true,
    agentPhase: 'idle',
    lastInteractionAt: STALE,
    idleSince: STALE,
    inActiveRun: false,
    ...overrides,
  }
}

const POLICY = { now: NOW, idleThresholdMs: DEFAULT_SUSPEND_IDLE_AFTER_MS }

run('an idle agent past the threshold is reapable regardless of cli', () => {
  for (const cli of ['claude-code', 'codex', 'some-future-cli', null]) {
    assert.equal(
      isSessionReapable(reapable({ cli }), POLICY),
      true,
      `expected reapable regardless of cli: ${cli ?? 'null'}`,
    )
  }
})

run('each safety gate independently keeps the terminal alive', () => {
  const cases: Array<[string, Partial<ReapCandidate>]> = [
    ['dead process', { processAlive: false }],
    ['plain shell (not agent)', { kind: 'terminal' }],
    ['in active managed run', { inActiveRun: true }],
    ['null workspace', { workspaceId: null }],
    ['interacted within the idle threshold', { lastInteractionAt: NOW - 1000, idleSince: NOW - 1000 }],
  ]
  for (const [label, override] of cases) {
    assert.equal(
      isSessionReapable(reapable(override), POLICY),
      false,
      `expected NOT reapable: ${label}`,
    )
  }
})

run('a working agent is never reaped, even when idle past the threshold by keystroke', () => {
  // Working with no keystrokes for hours: lastInteractionAt is old, but the
  // phase protects it — we must never kill an in-flight command.
  for (const phase of ['starting', 'thinking', 'tool_use'] as const) {
    assert.equal(
      isSessionReapable(reapable({ agentPhase: phase, idleSince: null }), POLICY),
      false,
      `expected working phase NOT reapable: ${phase}`,
    )
  }
})

run('an agent awaiting user input is never reaped', () => {
  assert.equal(
    isSessionReapable(reapable({ agentPhase: 'awaiting_input', idleSince: null }), POLICY),
    false,
  )
})

run('a stalled agent is never reaped (may be a long in-flight tool call)', () => {
  assert.equal(
    isSessionReapable(reapable({ agentPhase: 'stalled', idleSince: null }), POLICY),
    false,
  )
})

run('a visible (on-screen) idle agent IS reapable — visibility is not a reap signal', () => {
  // There is no `visible` field anymore; an on-screen dormant agent reaps like
  // any other. Freeze-the-view keeps its painted text readable.
  assert.equal(isSessionReapable(reapable(), POLICY), true)
})

run('a freshly-idle agent is protected until it has been idle past the threshold', () => {
  // Worked silently for a long time (old lastInteractionAt) then went idle just
  // now: idleSince pushes the clock forward, so it is NOT reaped yet.
  const justWentIdle = reapable({ lastInteractionAt: STALE, idleSince: NOW - 1000 })
  assert.equal(isSessionReapable(justWentIdle, POLICY), false)
  // Once it has been idle past the threshold (and no newer interaction), reap.
  const idleLongEnough = reapable({ lastInteractionAt: STALE, idleSince: STALE })
  assert.equal(isSessionReapable(idleLongEnough, POLICY), true)
})

run('the idle clock takes the most recent of interaction and idle-since', () => {
  // Recent keystroke after the agent went idle keeps it alive.
  assert.equal(
    isSessionReapable(reapable({ idleSince: STALE, lastInteractionAt: NOW - 5_000 }), POLICY),
    false,
  )
  // Both old → reapable.
  assert.equal(
    isSessionReapable(reapable({ idleSince: STALE, lastInteractionAt: STALE }), POLICY),
    true,
  )
})

run('a hookless agent (no phase) falls back to the keystroke-idle floor', () => {
  // No agent state at all: only recency decides. Past threshold → reapable.
  assert.equal(
    isSessionReapable(reapable({ agentPhase: null, idleSince: null, lastInteractionAt: STALE }), POLICY),
    true,
  )
  // Recent keystroke → kept.
  assert.equal(
    isSessionReapable(reapable({ agentPhase: null, idleSince: null, lastInteractionAt: NOW - 1000 }), POLICY),
    false,
  )
})

run('selectReapableSessions reaps only the dormant agents, keeping working/awaiting/run-active', () => {
  const candidates: ReapCandidate[] = [
    // Dormant idle agent, on screen and off — both reaped.
    reapable({ sessionId: 'idle-a', workspaceId: 'ws-a' }),
    reapable({ sessionId: 'idle-b', workspaceId: 'ws-b' }),
    // Working — kept.
    reapable({ sessionId: 'working', workspaceId: 'ws-c', agentPhase: 'thinking', idleSince: null }),
    // Awaiting input — kept.
    reapable({ sessionId: 'awaiting', workspaceId: 'ws-d', agentPhase: 'awaiting_input', idleSince: null }),
    // Managed run — kept.
    reapable({ sessionId: 'run', workspaceId: 'ws-e', inActiveRun: true }),
    // Recently typed — kept.
    reapable({ sessionId: 'fresh', workspaceId: 'ws-f', lastInteractionAt: NOW - 1000, idleSince: NOW - 1000 }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW })
  assert.deepEqual(decision.reapableSessionIds.sort(), ['idle-a', 'idle-b'])
})

run('default idle threshold is applied when not overridden', () => {
  const justUnder = reapable({
    sessionId: 'under',
    lastInteractionAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS - 1000),
    idleSince: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS - 1000),
  })
  const justOver = reapable({
    sessionId: 'over',
    lastInteractionAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS + 1000),
    idleSince: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS + 1000),
  })
  const decision = selectReapableSessions([justUnder, justOver], { now: NOW })
  assert.deepEqual(decision.reapableSessionIds, ['over'])
})

console.log('terminal-reap-policy tests passed')
