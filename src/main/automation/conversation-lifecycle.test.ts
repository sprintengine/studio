import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import {
  applyWorkspaceFieldsPatch,
  type WorkspaceFieldsPatch,
  type WorkspaceSyncEvent,
} from '../../shared/workspace-sync'
import { settleWorkspacePatch } from '../../shared/workspace-lifecycle'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { createConversationLifecycle, createConversationListChangeFilter } from './conversation-lifecycle'
import { createConversationTools } from './conversation-tools'

const NOW = 1_000_000

function fixture(record: Partial<WorkspaceRegistryRecord> | null, options: { working?: boolean } = {}) {
  const stored = record
    ? ({ id: 'ws-1', name: 'Fix the login', createdAt: 10, ...record } as WorkspaceRegistryRecord)
    : null
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (stored && workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      // Applied the way main's reducer applies it, clocks only forward.
      if (stored) applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    isWorking: () => options.working === true,
    now: () => NOW,
  })
  const tools = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle,
  })
  const toolNamed = (name: string) => tools.find((candidate) => candidate.name === name)!
  return { stored, writes, lifecycle, settle: toolNamed('conversation.settle'), visit: toolNamed('conversation.visit') }
}

const TAILNET: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'device-1' } }

test('settling writes the row menu’s own Settle patch, as the paired device', async () => {
  const f = fixture({ lastTerminalActivityAt: 500, snoozedUntil: 2_000_000 })
  const result = await f.settle.handler({ workspaceId: 'ws-1' }, TAILNET)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: NOW })
  assert.deepEqual(f.writes, [
    {
      workspaceId: 'ws-1',
      patch: settleWorkspacePatch({ lastTerminalActivityAt: 500 }, NOW, 'settled'),
      actor: 'mobile',
    },
  ])
})

test('settled: false brings a chat back and holds it out of the sweep, as Un-settle does', async () => {
  const f = fixture({ settledAt: 900, settledOverride: 'settled' })
  const result = await f.settle.handler({ workspaceId: 'ws-1', settled: false })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: null })
  assert.deepEqual(f.writes, [
    { workspaceId: 'ws-1', patch: { settledAt: null, settledOverride: 'active' }, actor: 'gateway' },
  ])
})

test('settling a settled chat again writes nothing and answers when it was settled', async () => {
  const f = fixture({ settledAt: 900 })
  const result = await f.settle.handler({ workspaceId: 'ws-1' })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', settledAt: 900 })
  assert.deepEqual(f.writes, [])
})

test('a chat whose agent is working is not settled', async () => {
  const f = fixture({}, { working: true })
  const result = await f.settle.handler({ workspaceId: 'ws-1' })
  assert.equal(result.isError, true)
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'working')
  assert.deepEqual(f.writes, [])
})

test('an unknown chat is refused by name, by both tools', async () => {
  const f = fixture(null)
  for (const handler of [f.settle.handler, f.visit.handler]) {
    const result = await handler({ workspaceId: 'ws-9' })
    assert.equal(result.isError, true)
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')
  }
})

test('bad arguments are refused before anything is read', async () => {
  const f = fixture({})
  const refusals = [
    await f.settle.handler({}),
    await f.settle.handler({ workspaceId: 'ws-1', settled: 'yes' }),
    await f.visit.handler({ workspaceId: '  ' }),
    await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 'now' }),
    await f.visit.handler({ workspaceId: 'ws-1', visitedAt: -5 }),
  ]
  for (const result of refusals)
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.deepEqual(f.writes, [])
})

test('a visit moves the visit clock forward and touches nothing else', async () => {
  const f = fixture({ lastVisitedAt: 100, settledAt: 50, lastUserMessageAt: 40 })
  const result = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 700 }, TAILNET)
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 700 })
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { lastVisitedAt: 700 }, actor: 'mobile' }])
  assert.equal(f.stored?.settledAt, 50, 'a settled chat stays settled')
  assert.equal(f.stored?.lastUserMessageAt, 40, 'a visit is not a message')
})

test('an earlier visit changes nothing and answers the clock as it stands', async () => {
  const f = fixture({ lastVisitedAt: 800 })
  const result = await f.visit.handler({ workspaceId: 'ws-1', visitedAt: 700 })
  assert.deepEqual(result.structuredContent, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 800 })
  assert.deepEqual(f.writes, [])
})

test('a visit is never later than this machine’s own now, and defaults to it', async () => {
  const ahead = fixture({})
  await ahead.visit.handler({ workspaceId: 'ws-1', visitedAt: NOW + 60_000 })
  assert.equal(ahead.stored?.lastVisitedAt, NOW)
  const omitted = fixture({})
  await omitted.visit.handler({ workspaceId: 'ws-1' })
  assert.equal(omitted.stored?.lastVisitedAt, NOW)
})

test('a message from a paired device moves the message clock and wakes a resting chat', () => {
  const f = fixture({ settledAt: 900, settledOverride: 'settled', lastUserMessageAt: 100 })
  f.lifecycle.noteUserMessage('ws-1', 2_000, 'gateway')
  assert.deepEqual(f.writes, [
    {
      workspaceId: 'ws-1',
      patch: { settledAt: null, settledOverride: null, lastUserMessageAt: 2_000 },
      actor: 'gateway',
    },
  ])
})

test('a message older than the clock writes nothing', () => {
  const f = fixture({ lastUserMessageAt: 3_000 })
  f.lifecycle.noteUserMessage('ws-1', 2_000, 'gateway')
  assert.deepEqual(f.writes, [])
})

function fieldsEvent(workspaceId: string, patch: WorkspaceFieldsPatch): WorkspaceSyncEvent {
  return {
    id: 'e',
    type: 'workspace.fields_updated',
    sourceWindowId: 'primary',
    sequence: 1,
    createdAt: 1,
    payload: { workspaceId, patch, editedAt: 1 },
  }
}

test('a settle, a message or a rename moves the conversation list a paired device reads', () => {
  const changed = createConversationListChangeFilter({ turnEndOf: () => undefined })
  assert.equal(changed(fieldsEvent('ws-1', { settledAt: 5 })), true)
  assert.equal(changed(fieldsEvent('ws-1', { settledAt: null, settledOverride: 'active' })), true)
  assert.equal(changed(fieldsEvent('ws-1', { lastUserMessageAt: 5 })), true)
  assert.equal(
    changed({
      id: 'e',
      type: 'workspace.renamed',
      sourceWindowId: 'primary',
      sequence: 2,
      createdAt: 1,
      payload: { workspaceId: 'ws-1', name: 'Fix the login', editedAt: 1 },
    } as WorkspaceSyncEvent),
    true,
  )
  assert.equal(changed(fieldsEvent('ws-1', { lastTerminalActivityAt: 5 })), false, 'a keystroke is not in the list')
})

test('a visit moves the list the first time, and again only once a turn has ended since', () => {
  let turnEnd: number | undefined = 100
  const changed = createConversationListChangeFilter({ turnEndOf: () => turnEnd })
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 200 })), true, 'the first visit this run')
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 210 })), false, 'a visit with nothing new seen')
  turnEnd = 215
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 220 })), true, 'the first visit since a finish')
  assert.equal(changed(fieldsEvent('ws-1', { lastVisitedAt: 230 })), false)
})
