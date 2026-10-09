import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentPhaseEvent } from '../shared/agent-runtime'
import type { AgentNotificationMode } from '../shared/agent-notifications'
import type { ShellNotice } from '../server/shell-bridge/shell-bridge'
import { createAgentNotifier, type ChatLabel } from './agent-notifications'

// The OS banner a chat raises when it finishes or waits on the person while
// they are in another app.

function phase(overrides: Partial<AgentPhaseEvent>): AgentPhaseEvent {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    executionId: null,
    phase: 'idle',
    previousPhase: 'thinking',
    event: null,
    turnEnd: true,
    turnFailure: false,
    ts: 0,
    pendingWakeupAt: null,
    ...overrides,
  }
}

function harness(options: { mode?: AgentNotificationMode; focused?: boolean; label?: ChatLabel | null } = {}) {
  const shown: ShellNotice[] = []
  const notifier = createAgentNotifier({
    mode: () => options.mode ?? 'banner',
    isAnyWindowFocused: () => options.focused ?? false,
    chatLabel: () => (options.label === undefined ? { title: 'Pricing page polish' } : options.label),
    show: (notice) => shown.push(notice),
  })
  return { notifier, shown }
}

test('a finished turn raises a silent banner that opens its chat', () => {
  const { notifier, shown } = harness()
  notifier.onAgentPhase(phase({}))
  assert.deepEqual(shown, [
    {
      key: 'chat:ws-1\0agent-1',
      title: 'Pricing page polish',
      body: 'Finished.',
      silent: true,
      activate: { kind: 'chat', chatId: 'ws-1', agentId: 'agent-1' },
    },
  ])
})

test('an agent stopping to ask says it is waiting', () => {
  const { notifier, shown } = harness()
  notifier.onAgentPhase(phase({ phase: 'awaiting_input', previousPhase: 'tool_use', turnEnd: false }))
  assert.equal(shown[0]?.body, 'Waiting for you.')
})

test('a failed turn says so', () => {
  const { notifier, shown } = harness()
  notifier.onAgentPhase(phase({ turnFailure: true }))
  assert.equal(shown[0]?.body, 'Stopped with an error.')
})

test('a chat with several agents names the one that finished', () => {
  const { notifier, shown } = harness({ label: { title: 'Pricing page polish', agentName: 'Reviewer' } })
  notifier.onAgentPhase(phase({}))
  assert.equal(shown[0]?.body, 'Reviewer finished.')
})

test('banner and sound plays the sound', () => {
  const { notifier, shown } = harness({ mode: 'banner-sound' })
  notifier.onAgentPhase(phase({}))
  assert.equal(shown[0]?.silent, false)
})

test('nothing is shown with the setting off', () => {
  const { notifier, shown } = harness({ mode: 'off' })
  notifier.onAgentPhase(phase({}))
  assert.equal(shown.length, 0)
})

test('nothing is shown while a Studio window has focus', () => {
  const { notifier, shown } = harness({ focused: true })
  notifier.onAgentPhase(phase({}))
  assert.equal(shown.length, 0)
})

test('a chat the sidebar does not list is never announced', () => {
  const { notifier, shown } = harness({ label: null })
  notifier.onAgentPhase(phase({}))
  assert.equal(shown.length, 0)
})

test('the steps inside a turn, and a question already asked, raise nothing', () => {
  const { notifier, shown } = harness()
  notifier.onAgentPhase(phase({ phase: 'tool_use', turnEnd: false }))
  notifier.onAgentPhase(phase({ phase: 'awaiting_input', previousPhase: 'awaiting_input', turnEnd: false }))
  notifier.onAgentPhase(phase({ workspaceId: null }))
  assert.equal(shown.length, 0)
})
