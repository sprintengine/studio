import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { BrowserWindow } from 'electron'

import type { ChatLink } from '../shared/deep-link'
import { createShellReveal } from './shell-reveal'

// Where a clicked notice takes the person: a chat goes through the chat-link
// router, which picks the window that holds it.

function window(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: () => undefined } } as unknown as BrowserWindow
}

test('a chat target opens the chat through the link router', () => {
  const opened: ChatLink[] = []
  const revealed: BrowserWindow[] = []
  const reveal = createShellReveal({
    windows: () => [window()],
    isCanvasWorker: () => false,
    revealMainWindow: (win) => revealed.push(win),
    openChat: () => (link) => opened.push(link),
  })
  assert.equal(reveal({ kind: 'chat', chatId: 'ws-1', agentId: 'agent-1' }), true)
  assert.deepEqual(opened, [{ kind: 'chat', chatId: 'ws-1', agentId: 'agent-1' }])
  assert.equal(revealed.length, 0, 'the router raises the window that holds the chat')
})

test('before the router exists, a chat target brings the app forward', () => {
  const revealed: BrowserWindow[] = []
  const reveal = createShellReveal({
    windows: () => [window()],
    isCanvasWorker: () => false,
    revealMainWindow: (win) => revealed.push(win),
    openChat: () => null,
  })
  assert.equal(reveal({ kind: 'chat', chatId: 'ws-1' }), true)
  assert.equal(revealed.length, 1)
})
