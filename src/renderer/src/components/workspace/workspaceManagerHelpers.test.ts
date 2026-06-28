import assert from 'node:assert/strict'
import type { AgentState, SessionActivity, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import {
  compareSessionItemsByAttention,
  deriveSessionStatus,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import type { SessionItem } from './WorkspaceTopBar'

void main()

function main(): void {
  assertHookPhaseDrivesStatus()
  assertOutputRecencyFallback()
  assertFailedRetentionAndPrecedence()
  assertSprintEngineNeedsInput()
  assertLastActivityIsMaxOfOutputAndInput()
  assertAttentionFirstOrdering()
  assertAttentionToneNeverLies()
  console.log('workspaceManagerHelpers.test.ts: all assertions passed')
}

function snap(partial: {
  kind?: TerminalSessionSnapshot['kind']
  activity: SessionActivity
  agentState?: AgentState
  lastOutputAt?: number | null
  lastInputAt?: number | null
  processAlive?: boolean
}): TerminalSessionSnapshot {
  return {
    kind: partial.kind ?? 'agent',
    processAlive: partial.processAlive ?? true,
    activity: partial.activity,
    agentState: partial.agentState,
    lastOutputAt: partial.lastOutputAt ?? null,
    lastInputAt: partial.lastInputAt ?? null,
  } as unknown as TerminalSessionSnapshot
}

// The authoritative hook phase wins over output timing, and carries its own
// `since` and provenance through.
function assertHookPhaseDrivesStatus(): void {
  const awaiting = deriveSessionStatus(
    snap({
      activity: { kind: 'working', since: 10 },
      agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
    }),
    false,
  )
  assert.equal(awaiting.status, 'needs-input')
  assert.equal(awaiting.source, 'hook')
  assert.equal(awaiting.activitySince, 500, 'needs-input since comes from the hook frame')

  // A dead agent's stale awaiting_input is not a live attention request: the hook
  // disjunct is gated on processAlive, so it falls through to idle.
  const deadAwaiting = deriveSessionStatus(
    snap({
      processAlive: false,
      activity: { kind: 'exited', at: 700, exitCode: 0 },
      agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
    }),
    false,
  )
  assert.notEqual(deadAwaiting.status, 'needs-input', 'dead awaiting_input does not surface as needs-input')
  // But the Sprint Engine self-report stays ungated even when the pty is dead.
  const deadButRuntime = deriveSessionStatus(
    snap({
      processAlive: false,
      activity: { kind: 'exited', at: 700, exitCode: 0 },
      agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
    }),
    true,
  )
  assert.equal(deadButRuntime.status, 'needs-input', 'runtimeNeedsInput is not gated on liveness')

  for (const phase of ['starting', 'thinking', 'tool_use'] as const) {
    const working = deriveSessionStatus(
      snap({ activity: { kind: 'idle', since: 1 }, agentState: { phase, since: 42, source: 'hook' } }),
      false,
    )
    assert.equal(working.status, 'working', `${phase} -> working`)
    assert.equal(working.activitySince, 42)
  }

  // `idle` and `stalled` hook phases read as idle, not working.
  for (const phase of ['idle', 'stalled'] as const) {
    const idle = deriveSessionStatus(
      snap({ activity: { kind: 'working', since: 1 }, agentState: { phase, since: 99, source: 'hook' } }),
      false,
    )
    assert.equal(idle.status, 'idle', `${phase} -> idle even while bytes are flowing`)
    assert.equal(idle.source, 'hook')
  }
}

// Without a hook frame, fall back to the output-timing heuristic, marked inferred.
function assertOutputRecencyFallback(): void {
  const working = deriveSessionStatus(snap({ activity: { kind: 'working', since: 7 } }), false)
  assert.equal(working.status, 'working')
  assert.equal(working.source, 'inferred')
  assert.equal(working.activitySince, 7)

  const idle = deriveSessionStatus(snap({ activity: { kind: 'idle', since: 8 } }), false)
  assert.equal(idle.status, 'idle')
  assert.equal(idle.source, 'inferred')
}

// A retained crash surfaces as failed (with its exit code) and outranks any
// stale working signal.
function assertFailedRetentionAndPrecedence(): void {
  const failed = deriveSessionStatus(
    snap({
      activity: { kind: 'failed', at: 1234, exitCode: 137 },
      agentState: { phase: 'thinking', since: 1, source: 'hook' },
    }),
    true,
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.exitCode, 137)
  assert.equal(failed.activitySince, 1234, 'failed since comes from the exit timestamp')
}

// Needs-input also works for non-hook agents via the Sprint Engine MCP report.
function assertSprintEngineNeedsInput(): void {
  const info = deriveSessionStatus(snap({ activity: { kind: 'idle', since: 3 } }), true)
  assert.equal(info.status, 'needs-input')
  assert.equal(info.source, 'inferred')
}

function assertLastActivityIsMaxOfOutputAndInput(): void {
  assert.equal(
    deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: 100, lastInputAt: 250 }), false)
      .lastActivityAt,
    250,
  )
  assert.equal(
    deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: null, lastInputAt: null }), false)
      .lastActivityAt,
    null,
  )
}

function item(partial: { status: SessionItem['status']; activitySince?: number; lastActivityAt?: number | null }): SessionItem {
  return {
    status: partial.status,
    activitySince: partial.activitySince ?? 0,
    lastActivityAt: partial.lastActivityAt ?? null,
  } as unknown as SessionItem
}

// Rows sort attention-first: needs-input -> failed -> working -> idle, then most
// recently active first within a tier.
function assertAttentionFirstOrdering(): void {
  const rows = [
    item({ status: 'idle', lastActivityAt: 100 }),
    item({ status: 'working' }),
    item({ status: 'failed' }),
    item({ status: 'needs-input' }),
    item({ status: 'idle', lastActivityAt: 900 }),
  ]
  const sorted = rows.slice().sort(compareSessionItemsByAttention).map((row) => row.status)
  assert.deepEqual(sorted, ['needs-input', 'failed', 'working', 'idle', 'idle'])

  const idleByRecency = [
    item({ status: 'idle', lastActivityAt: 100 }),
    item({ status: 'idle', lastActivityAt: 900 }),
  ]
    .sort(compareSessionItemsByAttention)
    .map((row) => row.lastActivityAt)
  assert.deepEqual(idleByRecency, [900, 100], 'more recent idle first')
}

// The trigger badge tone must escalate, never repeat a flat "all good".
function assertAttentionToneNeverLies(): void {
  assert.equal(sessionsAttentionTone([]), 'good')
  assert.equal(sessionsAttentionTone([item({ status: 'working' }), item({ status: 'idle' })]), 'good')
  assert.equal(sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'working' })]), 'error')
  assert.equal(
    sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'needs-input' })]),
    'warn',
    'needs-input outranks failed for tone',
  )
}
