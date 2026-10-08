import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentPhaseEvent } from '../shared/agent-runtime'
import { createAgentKeepAwake, STALE_AGENT_MS, terminalAgentWorking, type LiveWorkingLookup } from './agent-keep-awake'

function phase(
  agentId: string,
  value: AgentPhaseEvent['phase'],
  extra: Partial<AgentPhaseEvent> = {},
): AgentPhaseEvent {
  return {
    workspaceId: 'ws-1',
    agentId,
    executionId: null,
    phase: value,
    previousPhase: null,
    event: null,
    turnEnd: false,
    turnFailure: false,
    ts: 0,
    pendingWakeupAt: null,
    ...extra,
  }
}

function harness(options: { enabled?: boolean; live?: LiveWorkingLookup } = {}) {
  let enabled = options.enabled ?? true
  let live = options.live
  let clock = 1_000
  let nextId = 1
  const held = new Set<number>()
  const calls: string[] = []
  let sweep: (() => void) | null = null
  const keepAwake = createAgentKeepAwake({
    blocker: {
      start: (type) => {
        calls.push(`start:${type}`)
        const id = nextId++
        held.add(id)
        return id
      },
      stop: (id) => {
        calls.push(`stop:${id}`)
        held.delete(id)
      },
    },
    isEnabled: () => enabled,
    liveWorking: () => (workspaceId, agentId) => live?.(workspaceId, agentId),
    now: () => clock,
    setInterval: (callback) => {
      sweep = callback
      return 'sweep'
    },
    clearInterval: () => {
      sweep = null
    },
  })
  return {
    keepAwake,
    held,
    calls,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    setLive: (next: LiveWorkingLookup) => {
      live = next
    },
    advance: (ms: number) => {
      clock += ms
    },
    runSweep: () => sweep?.(),
    sweepRunning: () => sweep !== null,
  }
}

test('an agent starting work holds the machine awake, and it is let go when the agent stops', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking'))
  assert.deepEqual(h.calls, ['start:prevent-app-suspension'])
  assert.equal(h.held.size, 1)
  h.keepAwake.onAgentPhase(phase('agent-1', 'tool_use'))
  assert.equal(h.calls.length, 1, 'a second working phase takes no second blocker')
  h.keepAwake.onAgentPhase(phase('agent-1', 'idle', { turnEnd: true }))
  assert.equal(h.held.size, 0)
  assert.equal(h.keepAwake.isHolding(), false)
})

test('the blocker is held while any agent works and released at the last', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking'))
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking', { workspaceId: 'ws-2' }))
  assert.equal(h.keepAwake.workingCount(), 2, 'the same agent id in two chats is two agents')
  h.keepAwake.onAgentPhase(phase('agent-1', 'awaiting_input'))
  assert.equal(h.keepAwake.isHolding(), true)
  h.keepAwake.onAgentPhase(phase('agent-1', 'exited', { workspaceId: 'ws-2' }))
  assert.equal(h.keepAwake.isHolding(), false)
  assert.equal(h.held.size, 0)
})

test('a closed conversation stops counting even though it reports a working phase', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'tool_use'))
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking', { event: 'session_closed' }))
  assert.equal(h.keepAwake.workingCount(), 0)
  assert.equal(h.keepAwake.isHolding(), false)
})

test('with the setting off nothing is held, and turning it on or off applies at once', () => {
  const h = harness({ enabled: false })
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking'))
  assert.equal(h.calls.length, 0)
  assert.equal(h.keepAwake.workingCount(), 1, 'the agent is still counted for when it is turned on')
  h.setEnabled(true)
  h.keepAwake.refresh()
  assert.equal(h.keepAwake.isHolding(), true)
  h.setEnabled(false)
  h.keepAwake.refresh()
  assert.equal(h.keepAwake.isHolding(), false)
  assert.equal(h.held.size, 0)
})

test('a CLI that opened, or was resumed, and sits at its prompt is not working', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'starting', { event: 'SessionStart' }))
  assert.equal(h.keepAwake.workingCount(), 0)
  assert.equal(h.keepAwake.isHolding(), false)
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking', { event: 'UserPromptSubmit' }))
  assert.equal(h.keepAwake.isHolding(), true, 'its first prompt is work')
})

test('an interrupted turn the runtime has marked stalled is let go at the next check', () => {
  const h = harness({ live: () => true })
  h.keepAwake.onAgentPhase(phase('agent-1', 'tool_use'))
  h.runSweep()
  assert.equal(h.keepAwake.isHolding(), true, 'still working by the live state')
  // Esc sends no Stop: the phase stays tool_use until the runtime calls it stalled.
  h.setLive((workspaceId, agentId) => !(workspaceId === 'ws-1' && agentId === 'agent-1'))
  h.runSweep()
  assert.equal(h.keepAwake.workingCount(), 0)
  assert.equal(h.keepAwake.isHolding(), false)
  assert.equal(h.sweepRunning(), false)
})

test('a pty that exits mid-turn drops its agent at once', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'tool_use'))
  h.keepAwake.onAgentPhase(phase('agent-2', 'thinking'))
  h.keepAwake.onAgentExit({ workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(h.keepAwake.workingCount(), 1)
  h.keepAwake.onAgentExit({ workspaceId: 'ws-1', agentId: 'agent-2' })
  assert.equal(h.keepAwake.isHolding(), false)
  h.keepAwake.onAgentExit({ workspaceId: 'ws-1' })
  assert.equal(h.held.size, 0, 'an exit naming no agent changes nothing')
})

test('a terminal agent works while its process is up, awake and mid-turn', () => {
  const at = { since: 0, source: 'hook' as const }
  const alive = { processAlive: true, suspended: false }
  assert.equal(terminalAgentWorking({ ...alive, agentState: { ...at, phase: 'tool_use' } }), true)
  assert.equal(terminalAgentWorking({ ...alive, agentState: { ...at, phase: 'thinking' } }), true)
  assert.equal(terminalAgentWorking({ ...alive, agentState: { ...at, phase: 'stalled' } }), false)
  assert.equal(terminalAgentWorking({ ...alive, agentState: { ...at, phase: 'starting' } }), false)
  assert.equal(terminalAgentWorking({ ...alive, agentState: undefined }), false)
  assert.equal(terminalAgentWorking({ ...alive, processAlive: false, agentState: { ...at, phase: 'tool_use' } }), false)
  assert.equal(terminalAgentWorking({ ...alive, suspended: true, agentState: { ...at, phase: 'tool_use' } }), false)
})

test('an agent the live state does not know stops counting once it has been silent too long', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'tool_use'))
  h.advance(STALE_AGENT_MS / 2)
  h.keepAwake.onAgentPhase(phase('agent-2', 'thinking'))
  h.advance(STALE_AGENT_MS / 2 + 1)
  h.runSweep()
  assert.equal(h.keepAwake.workingCount(), 1, 'only the agent silent past the limit is dropped')
  assert.equal(h.keepAwake.isHolding(), true)
  h.advance(STALE_AGENT_MS)
  h.runSweep()
  assert.equal(h.keepAwake.workingCount(), 0)
  assert.equal(h.keepAwake.isHolding(), false)
  assert.equal(h.sweepRunning(), false, 'the sweep stops with nothing left to sweep')
})

test('quitting lets everything go', () => {
  const h = harness()
  h.keepAwake.onAgentPhase(phase('agent-1', 'thinking'))
  h.keepAwake.onAgentPhase(phase('agent-2', 'tool_use'))
  h.keepAwake.dispose()
  assert.equal(h.keepAwake.workingCount(), 0)
  assert.equal(h.held.size, 0)
  assert.equal(h.sweepRunning(), false)
})

test('a blocker the platform refuses is not fatal', () => {
  const keepAwake = createAgentKeepAwake({
    blocker: {
      start: () => {
        throw new Error('unsupported')
      },
      stop: () => undefined,
    },
    isEnabled: () => true,
    setInterval: () => 'sweep',
    clearInterval: () => undefined,
  })
  keepAwake.onAgentPhase(phase('agent-1', 'thinking'))
  assert.equal(keepAwake.isHolding(), false)
})
