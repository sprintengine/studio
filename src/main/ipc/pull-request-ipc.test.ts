import assert from 'node:assert/strict'

import type { IpcMain } from 'electron'
import { test } from 'vitest'

import { registerPullRequestIpc } from './pull-request-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function register(answer: (sessionId: string) => boolean): { handlers: Map<string, Handler>; asked: string[] } {
  const handlers = new Map<string, Handler>()
  const asked: string[] = []
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler)
    },
  } as unknown as IpcMain
  registerPullRequestIpc(ipcMain, {
    refreshPullRequestsForSession: (sessionId) => {
      asked.push(sessionId)
      return answer(sessionId)
    },
  })
  return { handlers, asked }
}

test('the shell registers only the session refresh; the lists are the server protocol’s', () => {
  const { handlers } = register(() => true)
  assert.deepEqual([...handlers.keys()], ['pullRequest:refreshForSession'])
})

test('a refresh says whether there was anything to ask about', async () => {
  const { handlers, asked } = register((sessionId) => sessionId === 'has-a-checkout')
  const refresh = handlers.get('pullRequest:refreshForSession')!
  assert.equal(await refresh({}, 'has-a-checkout'), true)
  assert.equal(await refresh({}, 'no-checkout-yet'), false)
  assert.deepEqual(asked, ['has-a-checkout', 'no-checkout-yet'])
})

test('a malformed id is dropped in silence and never reaches the shell', async () => {
  const { handlers, asked } = register(() => true)
  const refresh = handlers.get('pullRequest:refreshForSession')!
  for (const bad of [undefined, null, 42, '', 'x'.repeat(513), 'a\0b', { id: 's' }]) {
    assert.equal(await refresh({}, bad), false)
  }
  assert.deepEqual(asked, [])
})
