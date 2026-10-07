import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'vitest'

import { registerChatLinkIpc, routeSecondLaunch } from './chat-link-ipc'
import type { ChatLinkWindow } from './chat-link-router'
import {
  CHAT_LINK_ACK_CHANNEL,
  CHAT_LINK_READY_CHANNEL,
  CHAT_LINK_UNREADY_CHANNEL,
  type ChatLink,
} from '../shared/deep-link'

class FakeContents extends EventEmitter {}

class FakeWindow extends EventEmitter implements ChatLinkWindow {
  constructor(readonly contents: FakeContents) {
    super()
  }
  isDestroyed = () => false
  isFocused = () => false
  isVisible = () => true
  isMinimized = () => false
  restore = () => undefined
  focus = () => undefined
}

function harness() {
  const ipcMain = new EventEmitter()
  const calls: string[] = []
  const main = new FakeContents()
  const mainWindow = new FakeWindow(main)
  const aux = new FakeContents()
  const auxWindow = new FakeWindow(aux)
  const name = (win: FakeWindow) => (win === mainWindow ? 'main' : 'aux')
  registerChatLinkIpc<FakeContents, FakeWindow>({
    ipcMain,
    router: {
      windowReady: (win) => void calls.push(`ready ${name(win)}`),
      windowGone: (win) => void calls.push(`gone ${name(win)}`),
      ack: (win, generation) => void calls.push(`ack ${name(win)} ${generation}`),
    },
    windowOf: (contents) => (contents === main ? mainWindow : contents === aux ? auxWindow : null),
    // The aux window has a page of its own, but it is not a workspace window.
    isWorkspaceWindow: (contents) => contents === main,
  })
  const from = (contents: FakeContents, channel: string, ...args: unknown[]) =>
    void ipcMain.emit(channel, { sender: contents }, ...args)
  return { calls, main, mainWindow, aux, from }
}

test('a ready window is marked listening, and its page and window are watched once', () => {
  const h = harness()
  h.from(h.main, CHAT_LINK_READY_CHANNEL)
  h.from(h.main, CHAT_LINK_READY_CHANNEL)
  assert.deepEqual(h.calls, ['ready main', 'ready main'])
  assert.equal(h.main.listenerCount('did-navigate'), 1)
  assert.equal(h.main.listenerCount('render-process-gone'), 1)
  assert.equal(h.mainWindow.listenerCount('closed'), 1)
})

test('unready stops the window listening', () => {
  const h = harness()
  h.from(h.main, CHAT_LINK_READY_CHANNEL)
  h.from(h.main, CHAT_LINK_UNREADY_CHANNEL)
  assert.deepEqual(h.calls, ['ready main', 'gone main'])
})

test('a navigation, a crashed renderer and a closed window each stop it listening', () => {
  const h = harness()
  h.from(h.main, CHAT_LINK_READY_CHANNEL)
  h.main.emit('did-navigate')
  h.main.emit('render-process-gone')
  h.mainWindow.emit('closed')
  assert.deepEqual(h.calls, ['ready main', 'gone main', 'gone main', 'gone main'])
})

test('an acknowledgement passes its generation on, and one without a number is dropped', () => {
  const h = harness()
  h.from(h.main, CHAT_LINK_ACK_CHANNEL, 7)
  h.from(h.main, CHAT_LINK_ACK_CHANNEL, '7')
  h.from(h.main, CHAT_LINK_ACK_CHANNEL)
  h.from(h.main, CHAT_LINK_ACK_CHANNEL, 1.5)
  assert.deepEqual(h.calls, ['ack main 7'])
})

test('a page that is not a workspace window is ignored on every channel', () => {
  const h = harness()
  h.from(h.aux, CHAT_LINK_READY_CHANNEL)
  h.from(h.aux, CHAT_LINK_UNREADY_CHANNEL)
  h.from(h.aux, CHAT_LINK_ACK_CHANNEL, 1)
  assert.deepEqual(h.calls, [])
  assert.equal(h.aux.listenerCount('did-navigate'), 0)
})

test('a second launch carrying a chat link goes to the router alone', () => {
  const opened: ChatLink[] = []
  let windowsRaised = 0
  routeSecondLaunch(['/opt/SprintEngine Studio/sprintengine-studio', 'sprintengine://chat/ws1?agent=a1'], {
    openChatLink: (link) => void opened.push(link),
    openWindow: () => void (windowsRaised += 1),
  })
  assert.deepEqual(opened, [{ kind: 'chat', chatId: 'ws1', agentId: 'a1' }])
  assert.equal(windowsRaised, 0, 'the router raises the window the chat opens in, and only that one')
})

test('a second launch without a chat link brings a window forward', () => {
  const opened: ChatLink[] = []
  let windowsRaised = 0
  for (const argv of [
    ['/opt/SprintEngine Studio/sprintengine-studio'],
    ['app', 'sprintengine://auth/callback?code=x'],
  ]) {
    routeSecondLaunch(argv, {
      openChatLink: (link) => void opened.push(link),
      openWindow: () => void (windowsRaised += 1),
    })
  }
  assert.deepEqual(opened, [])
  assert.equal(windowsRaised, 2)
})
