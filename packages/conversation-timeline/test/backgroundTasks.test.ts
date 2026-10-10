import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { ConversationBackgroundTask } from '../src/protocol.js'
import { backgroundTasksWakeAgent, describeBackgroundTasks } from '../src/backgroundTasks.js'

const monitor: ConversationBackgroundTask = { taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }
const server: ConversationBackgroundTask = { taskId: 'task_dev', kind: 'command', description: 'npm run dev' }
const workflow: ConversationBackgroundTask = { taskId: 'task_flow', kind: 'task', description: 'Review the diff' }

test('a monitor or a task wakes the agent; a command, or a monitor with no deadline, does not', () => {
  assert.equal(backgroundTasksWakeAgent([monitor]), true)
  assert.equal(backgroundTasksWakeAgent([workflow]), true)
  assert.equal(backgroundTasksWakeAgent([server]), false)
  assert.equal(backgroundTasksWakeAgent([{ ...monitor, persistent: true }]), false)
  assert.equal(backgroundTasksWakeAgent([server, monitor]), true)
  assert.equal(backgroundTasksWakeAgent(undefined), false)
})

test('the line waits on what will wake the agent, and only runs what will not', () => {
  assert.equal(describeBackgroundTasks([]), null)
  assert.equal(describeBackgroundTasks([monitor]), 'Waiting on monitor: CI checks')
  assert.equal(
    describeBackgroundTasks([{ ...monitor, description: 'Watch CI for PR #42' }]),
    'Waiting on monitor: Watch CI for PR #42',
  )
  assert.equal(describeBackgroundTasks([workflow]), 'Waiting on background task: Review the diff')
  assert.equal(describeBackgroundTasks([{ taskId: 'm', kind: 'monitor' }]), 'Waiting on a monitor')
  assert.equal(describeBackgroundTasks([server]), 'Running: npm run dev')
  assert.equal(describeBackgroundTasks([{ taskId: 'c', kind: 'command' }]), 'Running a command')
  assert.equal(
    describeBackgroundTasks([server, monitor, { ...monitor, taskId: 'm2' }]),
    'Waiting on 2 monitors and 1 command',
  )
  assert.equal(
    describeBackgroundTasks([server, workflow, monitor]),
    'Waiting on 1 monitor, 1 background task and 1 command',
  )
  assert.equal(describeBackgroundTasks([server, { ...server, taskId: 'c2' }]), 'Running 2 commands')
})
