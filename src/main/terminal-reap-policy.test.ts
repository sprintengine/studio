import assert from 'node:assert/strict'
import {
  computeHotWorkspaceIds,
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
const STALE = NOW - DEFAULT_SUSPEND_IDLE_AFTER_MS - 60_000 // comfortably past the threshold

// A candidate that passes every gate. Tests flip one field at a time to prove
// each gate independently keeps a terminal alive.
function reapable(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-cold',
    kind: 'agent',
    cli: 'claude',
    activityKind: 'idle',
    visible: false,
    processAlive: true,
    lastSeenAt: STALE,
    inActiveRun: false,
    hasLiveChildProcess: false,
    ...overrides,
  }
}

const HOT_NONE = new Set<string>()
const POLICY = { now: NOW, idleThresholdMs: DEFAULT_SUSPEND_IDLE_AFTER_MS, resumableClis: ['claude'] }

run('a fully-idle, cold, resumable agent past the threshold is reapable', () => {
  assert.equal(isSessionReapable(reapable(), HOT_NONE, POLICY), true)
})

run('each safety gate independently keeps the terminal alive', () => {
  const cases: Array<[string, Partial<ReapCandidate>]> = [
    ['dead process', { processAlive: false }],
    ['plain shell (not agent)', { kind: 'terminal' }],
    ['non-resumable cli (codex)', { cli: 'codex' }],
    ['null cli', { cli: null }],
    ['working', { activityKind: 'working' }],
    ['needs-input', { activityKind: 'needs-input' }],
    ['failed', { activityKind: 'failed' }],
    ['visible on screen', { visible: true }],
    ['in active SprintEngine run', { inActiveRun: true }],
    ['has a live child (server/foreground cmd)', { hasLiveChildProcess: true }],
    ['null workspace', { workspaceId: null }],
    ['seen within the idle threshold', { lastSeenAt: NOW - 1000 }],
  ]
  for (const [label, override] of cases) {
    assert.equal(
      isSessionReapable(reapable(override), HOT_NONE, POLICY),
      false,
      `expected NOT reapable: ${label}`
    )
  }
})

run('a workspace in the hot set is never reaped, even when otherwise idle', () => {
  const hot = new Set(['ws-cold'])
  assert.equal(isSessionReapable(reapable(), hot, POLICY), false)
})

run('computeHotWorkspaceIds ranks by freshest alive session and respects the limit', () => {
  const candidates: ReapCandidate[] = [
    reapable({ sessionId: 'a', workspaceId: 'ws-1', lastSeenAt: NOW - 5000 }),
    reapable({ sessionId: 'b', workspaceId: 'ws-2', lastSeenAt: NOW - 1000 }),
    reapable({ sessionId: 'c', workspaceId: 'ws-2', lastSeenAt: NOW - 9000 }), // older sibling
    reapable({ sessionId: 'd', workspaceId: 'ws-3', lastSeenAt: NOW - 8000 }),
  ]
  // Freshest-first: ws-2 (1000) > ws-1 (5000) > ws-3 (8000).
  assert.deepEqual(computeHotWorkspaceIds(candidates, 2), ['ws-2', 'ws-1'])
  assert.deepEqual(computeHotWorkspaceIds(candidates, 5), ['ws-2', 'ws-1', 'ws-3'])
  assert.deepEqual(computeHotWorkspaceIds(candidates, 0), [])
})

run('computeHotWorkspaceIds ignores dead and null-workspace sessions', () => {
  const candidates: ReapCandidate[] = [
    reapable({ workspaceId: 'ws-dead', processAlive: false, lastSeenAt: NOW }),
    reapable({ workspaceId: null, lastSeenAt: NOW }),
    reapable({ workspaceId: 'ws-live', lastSeenAt: NOW - 5000 }),
  ]
  assert.deepEqual(computeHotWorkspaceIds(candidates, 5), ['ws-live'])
})

run('selectReapableSessions keeps the hot set resident and reaps the cold idle overflow', () => {
  const candidates: ReapCandidate[] = [
    // Hot: most recent, on screen — never reaped.
    reapable({ sessionId: 'hot', workspaceId: 'ws-hot', visible: true, lastSeenAt: NOW }),
    // Cold idle agent past threshold — reaped.
    reapable({ sessionId: 'cold-idle', workspaceId: 'ws-cold', lastSeenAt: STALE }),
    // Cold but working — kept.
    reapable({ sessionId: 'cold-working', workspaceId: 'ws-busy', activityKind: 'working', lastSeenAt: STALE }),
    // Cold idle but running a server — kept.
    reapable({ sessionId: 'cold-server', workspaceId: 'ws-srv', hasLiveChildProcess: true, lastSeenAt: STALE }),
  ]
  const decision = selectReapableSessions(candidates, { now: NOW, hotWorkspaceLimit: 1 })
  assert.deepEqual(decision.reapableSessionIds, ['cold-idle'])
  // ws-hot is freshest, so it owns the single hot slot.
  assert.deepEqual(decision.hotWorkspaceIds, ['ws-hot'])
})

run('default idle threshold is applied when not overridden', () => {
  const justUnder = reapable({ sessionId: 'under', lastSeenAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS - 1000) })
  const justOver = reapable({ sessionId: 'over', lastSeenAt: NOW - (DEFAULT_SUSPEND_IDLE_AFTER_MS + 1000) })
  const decision = selectReapableSessions([justUnder, justOver], { now: NOW, hotWorkspaceLimit: 0 })
  assert.deepEqual(decision.reapableSessionIds, ['over'])
})

console.log('terminal-reap-policy tests passed')
