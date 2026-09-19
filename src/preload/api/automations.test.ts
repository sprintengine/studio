import assert from 'node:assert/strict'

import { createAutomationsApi } from './automations'
import {
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
  type AutomationsRunEvent,
} from '../../shared/automations/contracts'
import type { AutomationsListResult } from '../../shared/automations/contracts'
import { test } from 'vitest'

test('automations', async () => {
  type Listener = (event: unknown, payload: unknown) => void

  async function main(): Promise<void> {
    const calls: Array<{ channel: string; input?: unknown }> = []
    const listeners = new Map<string, Set<Listener>>()
    const listResponse: AutomationsListResult = { ok: true, value: [] }

    const api = createAutomationsApi({
      async invoke(channel: string, input?: unknown) {
        calls.push({ channel, input })
        return listResponse
      },
      on(channel: string, listener: Listener) {
        const channelListeners = listeners.get(channel) ?? new Set<Listener>()
        channelListeners.add(listener)
        listeners.set(channel, channelListeners)
      },
      removeListener(channel: string, listener: Listener) {
        listeners.get(channel)?.delete(listener)
      },
    } as unknown as Parameters<typeof createAutomationsApi>[0])

    const listed = await api.listAutomations({ workspaceRoot: '/repo' })
    assert.deepEqual(listed, listResponse)
    assert.deepEqual(calls, [{ channel: AUTOMATIONS_LIST_CHANNEL, input: { workspaceRoot: '/repo' } }])

    const received: AutomationsRunEvent[] = []
    const unsubscribe = api.onAutomationRunEvent((event) => received.push(event))
    const event: AutomationsRunEvent = {
      automationId: 'nightly-review',
      runId: 'run-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      definitionName: 'Nightly Review',
      status: 'completed',
      trigger: 'timer',
    }
    const listener = [...(listeners.get(AUTOMATIONS_RUN_EVENT_CHANNEL) ?? [])][0]
    assert.ok(listener, 'run-event listener is registered')
    listener({}, event)
    assert.deepEqual(received, [event])

    unsubscribe()
    assert.equal(listeners.get(AUTOMATIONS_RUN_EVENT_CHANNEL)?.size, 0)

    console.log('automations-preload tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
