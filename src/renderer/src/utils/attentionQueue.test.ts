import assert from 'node:assert/strict'
import type { AgentState, SessionActivity, TerminalSessionSnapshot } from '../../../shared/electron-api'
import type { Workspace } from '../types/workspace'
import { attentionQueueBadge, buildAttentionQueueItems } from './attentionQueue'

function main(): void {
  assertOnlyAttentionStatusesPass()
  assertAttentionFirstOrdering()
  assertNeedsInputOutranksFailedForTone()
  assertEmptyQueueHidesBadge()
  console.log('attentionQueue.test.ts: all assertions passed')
}

// One workspace owning the given agents; `runtime` seeds the Sprint Engine
// per-agent state used to fold MCP needs_input into status.
function workspace(
  id: string,
  agentIds: string[],
  runtime?: Record<string, { status?: string }>,
): Workspace {
  const agents = Object.fromEntries(
    agentIds.map((agentId) => [agentId, { name: agentId, kind: 'agent', cli: 'claude' }]),
  )
  return {
    id,
    agents,
    sprintEngineState: runtime ? { sprintEngineAgents: runtime } : undefined,
  } as unknown as Workspace
}

function agentSession(partial: {
  agentId: string
  workspaceId: string
  activity: SessionActivity
  agentState?: AgentState
  processAlive?: boolean
  lastOutputAt?: number | null
}): TerminalSessionSnapshot {
  return {
    kind: 'agent',
    sessionId: `agent-${partial.agentId}`,
    agentId: partial.agentId,
    workspaceId: partial.workspaceId,
    activity: partial.activity,
    agentState: partial.agentState,
    // Live by default; a retained crash overrides this with processAlive: false.
    processAlive: partial.processAlive ?? true,
    lastOutputAt: partial.lastOutputAt ?? null,
    lastInputAt: null,
    cli: 'claude',
  } as unknown as TerminalSessionSnapshot
}

// Status shorthands so the cases below read as the status they exercise.
const hook = (phase: AgentState['phase'], since: number): AgentState => ({ phase, since, source: 'hook' })

function needsInput(agentId: string, workspaceId: string, lastOutputAt: number): TerminalSessionSnapshot {
  return agentSession({ agentId, workspaceId, activity: { kind: 'idle', since: 1 }, agentState: hook('awaiting_input', 1), lastOutputAt })
}
function failed(agentId: string, workspaceId: string, at: number): TerminalSessionSnapshot {
  return agentSession({ agentId, workspaceId, activity: { kind: 'failed', at, exitCode: 1 }, processAlive: false, lastOutputAt: at })
}
function working(agentId: string, workspaceId: string): TerminalSessionSnapshot {
  return agentSession({ agentId, workspaceId, activity: { kind: 'working', since: 1 }, agentState: hook('thinking', 1) })
}
function idle(agentId: string, workspaceId: string): TerminalSessionSnapshot {
  return agentSession({ agentId, workspaceId, activity: { kind: 'idle', since: 1 }, agentState: hook('idle', 1) })
}

// Only needs-input and failed sessions enter the queue; working and idle drop out.
function assertOnlyAttentionStatusesPass(): void {
  const ws = workspace('w1', ['a', 'b', 'c', 'd'])
  const items = buildAttentionQueueItems(
    [ws],
    [needsInput('a', 'w1', 100), failed('b', 'w1', 90), working('c', 'w1'), idle('d', 'w1')],
  )
  assert.deepEqual(
    items.map((item) => item.status).sort(),
    ['failed', 'needs-input'],
    'working and idle are excluded',
  )
}

// needs-input outranks failed, then most-recently-active first within a tier.
function assertAttentionFirstOrdering(): void {
  const ws = workspace('w1', ['old-need', 'new-need', 'crash'])
  const items = buildAttentionQueueItems(
    [ws],
    [needsInput('old-need', 'w1', 100), failed('crash', 'w1', 999), needsInput('new-need', 'w1', 500)],
  )
  assert.deepEqual(
    items.map((item) => item.agentId),
    ['new-need', 'old-need', 'crash'],
    'needs-input (recent first) before failed',
  )
}

// Tone escalates honestly: any needs-input → warn even when a crash is also present.
function assertNeedsInputOutranksFailedForTone(): void {
  const ws = workspace('w1', ['need', 'crash'])
  const mixed = buildAttentionQueueItems([ws], [needsInput('need', 'w1', 10), failed('crash', 'w1', 20)])
  assert.equal(attentionQueueBadge(mixed).tone, 'warn', 'needs-input outranks failed for tone')

  const crashOnly = buildAttentionQueueItems([workspace('w2', ['crash'])], [failed('crash', 'w2', 5)])
  assert.equal(attentionQueueBadge(crashOnly).tone, 'error', 'failed-only is an error tone')
}

// Zero items hides the badge: count 0, tone null.
function assertEmptyQueueHidesBadge(): void {
  const ws = workspace('w1', ['c', 'd'])
  const items = buildAttentionQueueItems([ws], [working('c', 'w1'), idle('d', 'w1')])
  assert.deepEqual(items, [])
  assert.deepEqual(attentionQueueBadge(items), { count: 0, tone: null })
}

void main()
