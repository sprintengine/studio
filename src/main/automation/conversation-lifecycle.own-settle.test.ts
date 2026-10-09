import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { createConversationLifecycle, onlyOwnChatTurn, OWN_SETTLE_GRACE_MS } from './conversation-lifecycle'
import { createConversationTools } from './conversation-tools'

// An agent settling its own chat: answered "when this turn ends", carried out
// once that turn completes, and let go when anything else happens first.

const NOW = 1_000_000

function fixture(options: { working?: boolean; onlyTurnOf?: string | null; messageWaiting?: boolean } = {}) {
  const stored = { id: 'ws-1', name: 'Fix the login', createdAt: 10 } as WorkspaceRegistryRecord
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const state = {
    working: options.working ?? true,
    onlyTurnOf: options.onlyTurnOf === undefined ? 'agent-1' : options.onlyTurnOf,
    messageWaiting: options.messageWaiting ?? false,
  }
  const timers: Array<{ job: () => void; ms: number; cancelled: boolean }> = []
  const logs: string[] = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing is marked unread here'),
    isWorking: () => state.working,
    onlyTurnOf: (_workspaceId, agentId) => state.onlyTurnOf === agentId,
    messageWaiting: () => state.messageWaiting,
    schedule: (job, ms) => {
      const timer = { job, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    log: (message) => logs.push(message),
    now: () => NOW,
  })
  const settleTool = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  }).find((tool) => tool.name === 'conversation.settle')!
  /** Run every timer due, as the clock reaching them would. */
  const elapse = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.job()
  }
  const event = (type: ConversationEvent['type'], fields: Partial<ConversationEvent> = {}) =>
    lifecycle.onConversationEvent({
      id: `evt-${type}`,
      sessionId: 'conv-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'mock',
      modelId: 'default',
      type,
      createdAt: NOW,
      ...fields,
    })
  return { stored, writes, state, timers, logs, lifecycle, settleTool, elapse, event }
}

const agentOf = (workspaceId: string, agentId: string): McpConnectionContext => ({
  metadata: { kind: 'studio-agent', workspaceId, agentId },
})
const OWN_AGENT = agentOf('ws-1', 'agent-1')

const errorCode = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error?: { code: string } }).error?.code

test('an agent settling its own chat mid-turn is told it settles when the turn ends', async () => {
  const f = fixture()
  const result = await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  assert.equal(result.isError, undefined)
  const answer = result.structuredContent as Record<string, unknown>
  assert.equal(answer.ok, true)
  assert.equal(answer.settlesWhenTurnEnds, true)
  assert.equal(answer.settledAt, null)
  assert.match(String(answer.note), /current turn completes/)
  assert.deepEqual(f.writes, [])
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), true)
})

test('the chat settles once that turn completes, after the grace, through the same settle', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_completed')
  assert.equal(f.writes.length, 0, 'nothing is written at the turn end itself')
  assert.equal(f.timers[0]?.ms, OWN_SETTLE_GRACE_MS)
  f.state.working = false
  f.elapse()
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].patch.settledAt, NOW)
  assert.equal(f.writes[0].actor, 'gateway')
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('a turn that fails is not followed by a settle', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_failed', { payload: { reason: 'runtime', message: 'The model call failed.' } })
  f.state.working = false
  f.event('turn_completed')
  f.elapse()
  assert.deepEqual(f.writes, [])
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('a turn the person stopped is not followed by a settle', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_failed', { payload: { reason: 'interrupted', message: 'Conversation interrupted.' } })
  f.state.working = false
  f.elapse()
  assert.deepEqual(f.writes, [])
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('a message the person sends before the turn ends lets the settle go', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('user_message', { payload: { text: 'one more thing' } })
  f.event('turn_completed')
  f.state.working = false
  f.elapse()
  assert.deepEqual(f.writes, [])
})

test('a queued message going in during the grace lets the settle go', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_completed')
  f.event('user_message', { payload: { text: 'and then this' } })
  assert.equal(f.timers[0].cancelled, true)
  f.state.working = false
  f.elapse()
  assert.deepEqual(f.writes, [])
})

test('a message held for the turn end keeps the chat from settling', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_completed')
  f.state.working = false
  f.state.messageWaiting = true
  f.elapse()
  assert.deepEqual(f.writes, [])
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('another agent still working when the grace runs out leaves the chat as it is', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_completed')
  // Still working: another agent of the chat started meanwhile.
  f.elapse()
  assert.deepEqual(f.writes, [])
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
  assert.match(f.logs[0] ?? '', /working/)
})

test('another agent’s turn ending does not carry out the settle', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  f.event('turn_completed', { agentId: 'agent-2', sessionId: 'conv-2' })
  assert.equal(f.timers.length, 0)
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), true)
})

test('an agent asking from another chat is still refused while this one works', async () => {
  const f = fixture({ onlyTurnOf: 'agent-9' })
  const result = await f.settleTool.handler({ workspaceId: 'ws-1' }, agentOf('ws-2', 'agent-9'))
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), 'working')
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('the person, or a paired device, is still refused while an agent works', async () => {
  const f = fixture()
  for (const context of [undefined, { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } } as const]) {
    const result = await f.settleTool.handler({ workspaceId: 'ws-1' }, context)
    assert.equal(errorCode(result), 'working')
  }
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('an agent whose turn is not the only work in its chat is refused as working', async () => {
  const f = fixture({ onlyTurnOf: null })
  const result = await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  assert.equal(errorCode(result), 'working')
  assert.equal(f.lifecycle.settlesWhenTurnEnds('ws-1'), false)
})

test('bringing the chat back takes back a settle waiting on a turn', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  await f.settleTool.handler({ workspaceId: 'ws-1', settled: false }, OWN_AGENT)
  f.event('turn_completed')
  f.state.working = false
  f.elapse()
  assert.deepEqual(f.writes, [])
})

test('asking twice in one turn is answered the same and settles once', async () => {
  const f = fixture()
  await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  const again = await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  assert.equal((again.structuredContent as Record<string, unknown>).settlesWhenTurnEnds, true)
  f.event('turn_completed')
  f.event('turn_completed')
  assert.equal(f.timers.length, 1)
  f.state.working = false
  f.elapse()
  assert.equal(f.writes.length, 1)
})

test('an agent asking while its chat is idle settles it at once, as before', async () => {
  const f = fixture({ working: false })
  const result = await f.settleTool.handler({ workspaceId: 'ws-1' }, OWN_AGENT)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: NOW })
  assert.equal(f.writes.length, 1)
})

const summary = (fields: Partial<ConversationSessionSummary>): ConversationSessionSummary =>
  ({
    sessionId: 'conv-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock',
    modelId: 'default',
    status: 'active',
    phase: 'running',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }) as ConversationSessionSummary

test('the own turn is the only work when the asking chat alone is mid-turn', () => {
  const resting = summary({ sessionId: 'conv-2', agentId: 'agent-2', status: 'ready', phase: 'completed' })
  assert.equal(onlyOwnChatTurn([summary({}), resting], 'agent-1'), true)
})

test('another chat at work, or an agent the asking one launched, is more than its own turn', () => {
  const busy = summary({ sessionId: 'conv-2', agentId: 'agent-2' })
  assert.equal(onlyOwnChatTurn([summary({}), busy], 'agent-1'), false)
  assert.equal(onlyOwnChatTurn([summary({ backgroundAgents: 1 })], 'agent-1'), false)
})

test('an agent with no chat mid-turn in the workspace has no own turn to wait on', () => {
  assert.equal(onlyOwnChatTurn([summary({ status: 'ready', phase: 'completed' })], 'agent-1'), false)
  assert.equal(onlyOwnChatTurn([summary({ agentId: 'agent-2' })], 'agent-1'), false)
})
