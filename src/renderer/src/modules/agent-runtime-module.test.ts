import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { AppNotification } from '../types/workspace'
import { agentRuntimeRendererModule } from './agent-runtime-module'
import type { NotificationActionProvider, RendererHost } from './renderer-host'

// The bell row for a first message that never reached its CLI gives the
// message back; every other terminal row keeps the shell's generic Open.

function terminalProvider(): NotificationActionProvider {
  const providers: NotificationActionProvider[] = []
  const host = new Proxy({} as RendererHost, {
    get: (_target, key) =>
      key === 'registerNotificationActionProvider'
        ? (provider: NotificationActionProvider) => providers.push(provider)
        : () => undefined,
  })
  agentRuntimeRendererModule.registerRenderer?.(host)
  const provider = providers.find((candidate) => candidate.source === 'terminal')
  assert.ok(provider, 'the core registers a terminal provider')
  return provider
}

function row(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: 'n-1',
    timestamp: '2026-09-24T12:00:00.000Z',
    level: 'error',
    source: 'terminal',
    title: 'Iris did not get your first message',
    message: 'Kimi Code exited before it was ready for input.',
    read: false,
    ...overrides,
  }
}

const originalApi = (globalThis as { window?: { api?: unknown } }).window?.api

afterEach(() => {
  const target = (globalThis as { window?: { api?: unknown } }).window
  if (target) target.api = originalApi
})

test('Copy message puts the returned message on the clipboard exactly as written', async () => {
  const copied: string[] = []
  const target = ((globalThis as { window?: { api?: unknown } }).window ??= {} as { api?: unknown })
  target.api = { clipboardWriteText: async (text: string) => void copied.push(text) }
  const revealed: string[] = []
  const context = {
    notification: row({ returnedPrompt: 'Refactor the parser\n\nand keep the tests green', workspaceId: 'ws-1' }),
    revealWorkspace: (workspaceId: string) => void revealed.push(workspaceId),
  }
  const actions = terminalProvider().resolveActions(context)
  assert.deepEqual(
    actions.map((action) => action.label),
    ['Copy message', 'Open'],
  )
  await actions[0]?.run(context)
  assert.deepEqual(copied, ['Refactor the parser\n\nand keep the tests green'])
  await actions[1]?.run(context)
  assert.deepEqual(revealed, ['ws-1'])
})

test('a terminal row with no returned message gets no provider action', () => {
  const actions = terminalProvider().resolveActions({
    notification: row({ title: 'Iris was not started', workspaceId: 'ws-1' }),
    revealWorkspace: () => {},
  })
  assert.deepEqual(actions, [])
})
