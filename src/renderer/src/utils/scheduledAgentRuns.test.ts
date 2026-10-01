import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../types/workspace'
import { isScheduledRunChat, scheduledAgentRunInProgress, scheduledAgentRuns } from './scheduledAgentRuns'

type RunFields = Pick<Workspace, 'id' | 'name' | 'createdAt' | 'scheduledAgentId'>

const chat = (id: string, createdAt: number, scheduledAgentId?: string | null): RunFields => ({
  id,
  name: `Chat ${id}`,
  createdAt,
  ...(scheduledAgentId === undefined ? {} : { scheduledAgentId }),
})

test('only a chat a schedule started wears the clock', () => {
  assert.equal(isScheduledRunChat({ scheduledAgentId: 'sa-1' }), true)
  assert.equal(isScheduledRunChat({}), false, 'a chat a person started')
  assert.equal(isScheduledRunChat({ scheduledAgentId: null }), false)
  assert.equal(isScheduledRunChat({ scheduledAgentId: '  ' }), false)
})

test("a schedule's runs are its tagged chats, newest first, a handful of them", () => {
  const workspaces = [
    chat('w1', 100, 'sa-1'),
    chat('w2', 300, 'sa-1'),
    chat('w3', 200, 'sa-2'),
    chat('w4', 400),
    chat('w5', 250, 'sa-1'),
  ]
  const runs = scheduledAgentRuns(workspaces, 'sa-1', { w2: 'working' })
  assert.deepEqual(
    runs.map((run) => [run.workspaceId, run.activity]),
    [
      ['w2', 'working'],
      ['w5', 'idle'],
      ['w1', 'idle'],
    ],
  )
  assert.equal(runs[0]!.title, 'Chat w2')
  assert.equal(runs[0]!.startedAt, 300)
  assert.deepEqual(
    scheduledAgentRuns(workspaces, 'sa-1', {}, 2).map((run) => run.workspaceId),
    ['w2', 'w5'],
  )
  assert.deepEqual(scheduledAgentRuns(workspaces, 'sa-9', {}), [])
})

test("a schedule's row says its latest run is going only while that run's chat is", () => {
  const lastRun = { at: 1, ok: true as const, workspaceId: 'w2' }
  assert.equal(scheduledAgentRunInProgress({ lastRun }, { w2: 'working' }), 'working')
  assert.equal(scheduledAgentRunInProgress({ lastRun }, { w2: 'needs-input' }), 'needs-input')
  assert.equal(scheduledAgentRunInProgress({ lastRun }, { w2: 'idle' }), null)
  assert.equal(scheduledAgentRunInProgress({ lastRun }, {}), null, 'a chat closed since')
  assert.equal(scheduledAgentRunInProgress({ lastRun }, { w1: 'working' }), null, 'an older run is not the latest')
  assert.equal(
    scheduledAgentRunInProgress({ lastRun: { at: 1, ok: false, message: 'no repo' } }, { w2: 'working' }),
    null,
    'a run that did not start has no chat',
  )
  assert.equal(scheduledAgentRunInProgress({ lastRun: null }, {}), null)
})
