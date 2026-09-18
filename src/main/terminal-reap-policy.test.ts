import assert from 'node:assert/strict'
import {
  DEFAULT_SUSPEND_IDLE_AFTER_MS,
  explainSessionReapDecision,
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
    managed: false,
    reapExempt: false,
    pendingWakeupAt: null,
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
    ['user locked (keep running)', { reapExempt: true }],
    ['null workspace', { workspaceId: null }],
    ['interacted within the idle threshold', { lastInteractionAt: NOW - 1000, idleSince: NOW - 1000 }],
  ]
  for (const [label, override] of cases) {
    assert.equal(isSessionReapable(reapable(override), POLICY), false, `expected NOT reapable: ${label}`)
  }
})

run('a pending self-scheduled wakeup holds an otherwise-reapable agent until it fires', () => {
  // The ScheduleWakeup timer lives inside the CLI process; the agent is idle
  // while waiting, which is exactly what the reaper hunts. A future wake time
  // must hold regardless of rest, and the gate is named for the skip audit.
  const held = explainSessionReapDecision(reapable({ pendingWakeupAt: NOW + 60_000 }), POLICY)
  assert.deepEqual(held.verdict, 'held')
  assert.equal(held.verdict === 'held' ? held.hold : null, 'pending_wakeup')
  // A wakeup whose time has passed never holds: it either fired (follow-up
  // work re-protects via the phase gates) or the process is gone.
  assert.equal(isSessionReapable(reapable({ pendingWakeupAt: NOW - 1000 }), POLICY), true)
  assert.equal(isSessionReapable(reapable({ pendingWakeupAt: null }), POLICY), true)
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
  assert.equal(isSessionReapable(reapable({ agentPhase: 'awaiting_input', idleSince: null }), POLICY), false)
})

run('a stalled agent expires: reapable only after resting past the threshold', () => {
  // Stalled is inference-sourced — a lost Stop frame lands a genuinely-finished
  // agent here, so it must expire like idle rather than protect forever
  // (the 2026-07-07 parked-agents incident). It still rides the full idle
  // clock from the stall flag: freshly stalled (possibly a long silent tool
  // call) is kept…
  assert.equal(isSessionReapable(reapable({ agentPhase: 'stalled', idleSince: NOW - 1000 }), POLICY), false)
  // …a recent keystroke also keeps it…
  assert.equal(
    isSessionReapable(reapable({ agentPhase: 'stalled', idleSince: STALE, lastInteractionAt: NOW - 1000 }), POLICY),
    false,
  )
  // …but stalled AND rested past the threshold is reclaimed.
  assert.equal(isSessionReapable(reapable({ agentPhase: 'stalled', idleSince: STALE }), POLICY), true)
  // Boundary: expiry uses the same strict > threshold clock as idle.
  assert.equal(
    isSessionReapable(
      reapable({ agentPhase: 'stalled', idleSince: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS - 1000) }),
      POLICY,
    ),
    false,
  )
  assert.equal(
    isSessionReapable(
      reapable({ agentPhase: 'stalled', idleSince: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS + 1000) }),
      POLICY,
    ),
    true,
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
  assert.equal(isSessionReapable(reapable({ idleSince: STALE, lastInteractionAt: NOW - 5_000 }), POLICY), false)
  // Both old → reapable.
  assert.equal(isSessionReapable(reapable({ idleSince: STALE, lastInteractionAt: STALE }), POLICY), true)
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

run('selectReapableSessions reaps only the dormant agents, keeping working/awaiting/fresh', () => {
  const candidates: ReapCandidate[] = [
    // Dormant idle agent, on screen and off — both reaped.
    reapable({ sessionId: 'idle-a', workspaceId: 'ws-a' }),
    reapable({ sessionId: 'idle-b', workspaceId: 'ws-b' }),
    // Working — kept.
    reapable({ sessionId: 'working', workspaceId: 'ws-c', agentPhase: 'thinking', idleSince: null }),
    // Awaiting input — kept.
    reapable({ sessionId: 'awaiting', workspaceId: 'ws-d', agentPhase: 'awaiting_input', idleSince: null }),
    // Recently typed — kept.
    reapable({ sessionId: 'fresh', workspaceId: 'ws-f', lastInteractionAt: NOW - 1000, idleSince: NOW - 1000 }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW })
  assert.deepEqual(decision.reapableSessionIds.sort(), ['idle-a', 'idle-b'])
})

run('explainSessionReapDecision names the holding gate (skip-audit contract)', () => {
  const cases: Array<[Partial<ReapCandidate>, string]> = [
    [{ processAlive: false }, 'dead_process'],
    [{ kind: 'terminal' }, 'not_agent'],
    [{ workspaceId: null }, 'no_workspace'],
    [{ reapExempt: true }, 'user_locked'],
    [{ agentPhase: 'awaiting_input', idleSince: null }, 'phase_awaiting_input'],
    [{ agentPhase: 'starting', idleSince: null }, 'phase_working'],
    [{ agentPhase: 'thinking', idleSince: null }, 'phase_working'],
    [{ agentPhase: 'tool_use', idleSince: null }, 'phase_working'],
    [{ agentPhase: 'exited', idleSince: null }, 'phase_unrestful'],
    [{ lastInteractionAt: NOW - 1000, idleSince: NOW - 1000 }, 'resting_recently'],
  ]
  for (const [override, expectedHold] of cases) {
    const explanation = explainSessionReapDecision(reapable(override), POLICY)
    assert.equal(explanation.verdict, 'held', `expected held for ${expectedHold}`)
    if (explanation.verdict === 'held') assert.equal(explanation.hold, expectedHold)
  }
  // The boolean projection agrees with the explanation (single source of truth).
  const open = explainSessionReapDecision(reapable(), POLICY)
  assert.equal(open.verdict, 'reapable')
  assert.equal(isSessionReapable(reapable(), POLICY), true)
  // restingForMs reflects the same clock the decision uses.
  assert.equal(open.restingForMs, NOW - STALE)
})

run('recency floor spares the most recently used reapable agents', () => {
  // Five live idle agents, all past the threshold, resting for different
  // lengths. Floor of 3 → only the two OLDEST-rested are reaped; the three
  // most recently used stay alive and are named for the skip audit.
  const candidates: ReapCandidate[] = [1, 2, 3, 4, 5].map((n) =>
    reapable({
      sessionId: `idle-${n}`,
      workspaceId: `ws-${n}`,
      lastInteractionAt: STALE - n * 60_000,
      idleSince: STALE - n * 60_000,
    }),
  )
  const decision = selectReapableSessions(candidates, { now: NOW, keepRecentAliveCount: 3 })
  assert.deepEqual(decision.reapableSessionIds.sort(), ['idle-4', 'idle-5'])
  assert.deepEqual(decision.heldByRecencyFloorSessionIds.sort(), ['idle-1', 'idle-2', 'idle-3'])
})

run('recency floor counts protected live agents toward the floor', () => {
  // Two working agents + two reapable idle ones, floor 3: the working pair
  // already holds 2 of the floor, so ONE idle agent (the more recent) is
  // spared and the older one is reaped.
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'working-a', workspaceId: 'ws-a', agentPhase: 'thinking', idleSince: null }),
    reapable({ sessionId: 'working-b', workspaceId: 'ws-b', agentPhase: 'tool_use', idleSince: null }),
    reapable({
      sessionId: 'idle-old',
      workspaceId: 'ws-c',
      lastInteractionAt: STALE - 120_000,
      idleSince: STALE - 120_000,
    }),
    reapable({ sessionId: 'idle-new', workspaceId: 'ws-d' }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, keepRecentAliveCount: 3 })
  assert.deepEqual(decision.reapableSessionIds, ['idle-old'])
  assert.deepEqual(decision.heldByRecencyFloorSessionIds, ['idle-new'])
})

run('recency floor neither protects nor is occupied by module-managed agents', () => {
  // Two reapable module-managed agents (freshly rested, so they would out-rank
  // the user's terminals on recency) + one older reapable user agent, floor 2.
  // The managed agents must still be reaped and must NOT count toward the
  // user's keep-alive budget: with only one live user agent (≤ 2), the user
  // agent is spared.
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'managed-a', workspaceId: 'ws-a', managed: true }),
    reapable({ sessionId: 'managed-b', workspaceId: 'ws-b', managed: true }),
    reapable({
      sessionId: 'user-idle',
      workspaceId: 'ws-c',
      lastInteractionAt: STALE - 60_000,
      idleSince: STALE - 60_000,
    }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, keepRecentAliveCount: 2 })
  assert.deepEqual(decision.reapableSessionIds.sort(), ['managed-a', 'managed-b'])
  assert.deepEqual(decision.heldByRecencyFloorSessionIds, ['user-idle'])
})

run('recency floor of 0 (and omitted) reaps every qualifying agent', () => {
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'idle-a', workspaceId: 'ws-a' }),
    reapable({ sessionId: 'idle-b', workspaceId: 'ws-b' }),
  ]
  for (const options of [{ now: NOW }, { now: NOW, keepRecentAliveCount: 0 }]) {
    const decision = selectReapableSessions(candidates, options)
    assert.deepEqual(decision.reapableSessionIds.sort(), ['idle-a', 'idle-b'])
    assert.deepEqual(decision.heldByRecencyFloorSessionIds, [])
  }
})

run('recency floor ignores dead placeholders and plain shells when counting live agents', () => {
  // A suspended placeholder (dead process) and a plain shell must not satisfy
  // the floor — only LIVE agent terminals count, so with floor 1 the single
  // reapable live agent is spared.
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'suspended', workspaceId: 'ws-a', processAlive: false }),
    reapable({ sessionId: 'shell', workspaceId: 'ws-b', kind: 'terminal' }),
    reapable({ sessionId: 'idle-live', workspaceId: 'ws-c' }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, keepRecentAliveCount: 1 })
  assert.deepEqual(decision.reapableSessionIds, [])
  assert.deepEqual(decision.heldByRecencyFloorSessionIds, ['idle-live'])
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
