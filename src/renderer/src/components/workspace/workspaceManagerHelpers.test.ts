import assert from 'node:assert/strict'
import type { AgentState, SessionActivity, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { Workspace } from '../../types/workspace'
import {
  compareSessionItemsByAttention,
  deriveSessionStatus,
  getSessionItems,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import type { SessionItem } from './WorkspaceActions'

void main()

function main(): void {
  assertHookPhaseDrivesStatus()
  assertOutputRecencyFallback()
  assertFailedRetentionAndPrecedence()
  assertSprintEngineNeedsInput()
  assertLastActivityIsMaxOfOutputAndInput()
  assertAttentionFirstOrdering()
  assertAttentionToneNeverLies()
  assertConversationSessionsSurfaceInSessionItems()
  assertWizardPtySessionsSurfaceWithHumanLabel()
  console.log('workspaceManagerHelpers.test.ts: all assertions passed')
}

// Wizard specialists on the PTY fallback transport spawn with workspaceId and
// agentName in the snapshot but no workspace.agents record. They must surface
// as labeled rows, and a conversation session for the same agent id must win
// over a stale PTY twin instead of duplicating the row.
function assertWizardPtySessionsSurfaceWithHumanLabel(): void {
  const workspace = {
    id: 'ws-wizard',
    name: 'Design System Studio',
    agents: {},
  } as unknown as Workspace
  const wizardPtySnap = {
    sessionId: 'pty-wizard-1',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-wizard',
    agentId: 'guided-brief-design-system',
    agentName: 'Design System Designer',
    cli: 'claude-code',
    activity: { kind: 'working', since: 10 },
    lastOutputAt: 20,
    lastInputAt: null,
  } as unknown as TerminalSessionSnapshot

  const items = getSessionItems([workspace], [wizardPtySnap], [])
  assert.equal(items.length, 1, 'wizard PTY session with workspaceId surfaces')
  assert.equal(items[0]?.label, 'Design System Designer', 'labels from snapshot agentName, not the raw agent id')
  assert.equal(items[0]?.status, 'working')
  assert.equal(items[0]?.agentId, 'guided-brief-design-system')

  // Retained crash: the failed row keeps its human label too.
  const failedSnap = {
    ...(wizardPtySnap as unknown as Record<string, unknown>),
    processAlive: false,
    activity: { kind: 'failed', at: 30, exitCode: 1 },
  } as unknown as TerminalSessionSnapshot
  const failedItems = getSessionItems([workspace], [failedSnap], [])
  assert.equal(failedItems.length, 1, 'crashed wizard session is retained')
  assert.equal(failedItems[0]?.status, 'failed')
  assert.equal(failedItems[0]?.label, 'Design System Designer')

  // Same agent id on both transports: the conversation row wins, no duplicate.
  const conversationTwin: ConversationSessionSummary = {
    sessionId: 'conv-wizard-1',
    workspaceId: 'ws-wizard',
    agentId: 'guided-brief-design-system',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status: 'active',
    createdAt: 40,
    updatedAt: 50,
  }
  const merged = getSessionItems([workspace], [wizardPtySnap], [conversationTwin])
  assert.equal(merged.length, 1, 'stale PTY twin is deduplicated against the conversation session')
  assert.equal(merged[0]?.sessionId, 'conv-wizard-1', 'the conversation row is the one kept')
  assert.equal(merged[0]?.label, 'Design System Designer')
}

// Conversation (chat) agents have no PTY snapshot; their runtime summaries
// must still produce session rows with truthful status mapping.
function assertConversationSessionsSurfaceInSessionItems(): void {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace One',
    agents: {
      'chat-1': { id: 'chat-1', name: 'Sonnet chat', runtimeKind: 'conversation' },
    },
  } as unknown as Workspace
  const summary = (status: ConversationSessionSummary['status']): ConversationSessionSummary => ({
    sessionId: `conv-${status}`,
    workspaceId: 'ws-1',
    agentId: 'chat-1',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status,
    createdAt: 10,
    updatedAt: 20,
  })

  const awaiting = getSessionItems([workspace], [], [summary('awaiting_approval')])
  assert.equal(awaiting.length, 1)
  assert.equal(awaiting[0]?.status, 'needs-input', 'pending approval/question reads as needs-input')
  assert.equal(awaiting[0]?.agentId, 'chat-1')
  assert.equal(awaiting[0]?.label, 'Sonnet chat')
  assert.equal(awaiting[0]?.cli, 'claude-code', 'claude-agent provider surfaces the Claude icon')

  assert.equal(getSessionItems([workspace], [], [summary('active')])[0]?.status, 'working')
  assert.equal(getSessionItems([workspace], [], [summary('ready')])[0]?.status, 'idle')
  assert.equal(getSessionItems([workspace], [], [summary('failed')])[0]?.status, 'failed')
  assert.equal(getSessionItems([workspace], [], [summary('stopped')]).length, 0, 'stopped sessions drop out')
  assert.equal(
    getSessionItems([], [], [summary('active')]).length,
    0,
    'summaries without a matching workspace are ignored',
  )

  // Wizard specialist sessions have no AgentState entry but must stay visible
  // in the session manager, with a readable role label.
  const wizardSummary: ConversationSessionSummary = {
    sessionId: 'conv-wizard',
    workspaceId: 'ws-1',
    agentId: 'guided-brief-strategist',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    status: 'awaiting_approval',
    createdAt: 10,
    updatedAt: 20,
  }
  const wizardItems = getSessionItems([workspace], [], [wizardSummary])
  assert.equal(wizardItems.length, 1, 'agent-less conversation session still surfaces')
  assert.equal(wizardItems[0]?.label, 'Product Strategist')
  assert.equal(wizardItems[0]?.status, 'needs-input')
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
