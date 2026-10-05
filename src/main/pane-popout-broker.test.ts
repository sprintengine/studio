import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createPanePopOutBroker, type PanePopOutPeer, type PanePopOutWindowHandle } from './pane-popout-broker'

// The pane pop-out's relay in main: who may open a window, who may speak for
// its tabs, and what happens to it when either end goes away. Windows are
// stand-ins that record what they were sent; identity is the object itself,
// as a WebContents is in the app.

type Sent = { channel: string; payload: unknown }

type FakePeer = PanePopOutPeer & { sent: Sent[]; destroyed: boolean }
type FakeWindow = PanePopOutWindowHandle & { sent: Sent[]; destroyed: boolean; focused: number; closed: number }

function peer(): FakePeer {
  const self: FakePeer = {
    id: null,
    sent: [],
    destroyed: false,
    isDestroyed: () => self.destroyed,
    send: (channel, payload) => self.sent.push({ channel, payload }),
  }
  self.id = self
  return self
}

function harness() {
  const opened: Array<{ popOutId: string; workspaceId: string; window: FakeWindow }> = []
  const broker = createPanePopOutBroker({
    openWindow: ({ popOutId, workspaceId }) => {
      const window: FakeWindow = {
        id: null,
        sent: [],
        destroyed: false,
        focused: 0,
        closed: 0,
        isDestroyed: () => window.destroyed,
        send: (channel, payload) => window.sent.push({ channel, payload }),
        focus: () => {
          window.focused += 1
        },
        close: () => {
          window.closed += 1
          window.destroyed = true
        },
      }
      window.id = window
      opened.push({ popOutId, workspaceId, window })
      return window
    },
  })
  return { broker, opened }
}

const STATE = { tabs: [{ id: 't1', kind: 'files' }], reveal: { tabId: 't1', key: 1 } }

test('an owner opens one window per pop-out id, and a repeat ask raises it', () => {
  const { broker, opened } = harness()
  const owner = peer()
  assert.deepEqual(broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' }), { ok: true })
  assert.deepEqual(broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' }), { ok: true })
  assert.equal(opened.length, 1, 'no second window for the same id')
  assert.equal(opened[0].window.focused, 1, 'the open one comes forward')
})

test('a malformed id or workspace opens nothing', () => {
  const { broker, opened } = harness()
  const owner = peer()
  assert.equal(broker.open(owner, { popOutId: '../x?aux=diff', workspaceId: 'ws-1' }).ok, false)
  assert.equal(broker.open(owner, { popOutId: '', workspaceId: 'ws-1' }).ok, false)
  assert.equal(broker.open(owner, { popOutId: 'pop-1', workspaceId: '' }).ok, false)
  assert.equal(broker.open(owner, null).ok, false)
  assert.equal(opened.length, 0)
})

test("another window cannot claim an open pop-out's id", () => {
  const { broker, opened } = harness()
  broker.open(peer(), { popOutId: 'pop-1', workspaceId: 'ws-1' })
  assert.deepEqual(broker.open(peer(), { popOutId: 'pop-1', workspaceId: 'ws-1' }), {
    ok: false,
    message: 'foreign_pop_out',
  })
  assert.equal(opened[0].window.focused, 0)
})

test("only the owner's push reaches the window, and a late boot is handed the last one", () => {
  const { broker, opened } = harness()
  const owner = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  const window = opened[0].window
  assert.deepEqual(broker.getState(window.id, { popOutId: 'pop-1' }), { workspaceId: 'ws-1', state: null })

  broker.push(peer().id, { popOutId: 'pop-1', state: STATE })
  assert.equal(window.sent.length, 0, 'a stranger speaks for nobody')
  broker.push(owner.id, { popOutId: 'pop-1', state: { tabs: 'nope' } })
  assert.equal(window.sent.length, 0, 'a push with no tab list is not relayed')

  broker.push(owner.id, { popOutId: 'pop-1', state: STATE })
  assert.deepEqual(window.sent, [{ channel: 'pane-popout:state', payload: { popOutId: 'pop-1', state: STATE } }])
  assert.deepEqual(broker.getState(window.id, { popOutId: 'pop-1' }), { workspaceId: 'ws-1', state: STATE })
  assert.equal(broker.getState(owner.id, { popOutId: 'pop-1' }), null, 'only the window itself is answered')
})

test("only the window's own actions reach its owner, and only known ones", () => {
  const { broker, opened } = harness()
  const owner = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  const window = opened[0].window

  assert.equal(broker.act(owner.id, { popOutId: 'pop-1', action: { type: 'close', tabId: 't1' } }), null)
  assert.equal(broker.act(window.id, { popOutId: 'pop-1', action: { type: 'format-disk' } }), null)
  assert.equal(owner.sent.length, 0)

  const relayed = broker.act(window.id, { popOutId: 'pop-1', action: { type: 'close', tabId: 't1' } })
  assert.equal(relayed?.ownerId, owner.id)
  assert.deepEqual(owner.sent, [
    { channel: 'pane-popout:action', payload: { popOutId: 'pop-1', action: { type: 'close', tabId: 't1' } } },
  ])
})

test('focus and close are the owner’s to ask for', () => {
  const { broker, opened } = harness()
  const owner = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  const window = opened[0].window
  broker.focus(peer().id, { popOutId: 'pop-1' })
  broker.close(peer().id, { popOutId: 'pop-1' })
  assert.equal(window.focused + window.closed, 0)
  broker.focus(owner.id, { popOutId: 'pop-1' })
  broker.close(owner.id, { popOutId: 'pop-1' })
  assert.equal(window.focused, 1)
  assert.equal(window.closed, 1)
})

test('a closed window hands its tabs back to the owner, once', () => {
  const { broker } = harness()
  const owner = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  broker.windowClosed('pop-1')
  broker.windowClosed('pop-1')
  assert.deepEqual(owner.sent, [{ channel: 'pane-popout:closed', payload: { popOutId: 'pop-1' } }])
})

test("an owner that closes or reloads takes its windows with it, and nobody else's", () => {
  const { broker, opened } = harness()
  const owner = peer()
  const other = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  broker.open(owner, { popOutId: 'pop-2', workspaceId: 'ws-2' })
  broker.open(other, { popOutId: 'pop-3', workspaceId: 'ws-3' })
  broker.ownerGone(owner.id)
  assert.deepEqual(
    opened.map((entry) => entry.window.closed),
    [1, 1, 0],
  )
  // Its ids are free again: the reloaded owner can pop the same tabs out anew.
  assert.equal(broker.open(other, { popOutId: 'pop-1', workspaceId: 'ws-1' }).ok, true)
})

test('a pop-out re-attaches only to a terminal it holds, and to none once its owner closes it', () => {
  const { broker, opened } = harness()
  const owner = peer()
  const workspaceWindow = peer()
  broker.open(owner, { popOutId: 'pop-1', workspaceId: 'ws-1' })
  const window = opened[0].window
  // Closing is asked, and the window goes some time after.
  window.close = () => {
    window.closed += 1
  }
  assert.equal(broker.mayAttachTerminal(window.id, 'terminal-a'), false, 'nothing pushed yet, nothing held')
  broker.push(owner, {
    popOutId: 'pop-1',
    state: { tabs: [{ id: 't1', kind: 'terminal', terminalId: 'a' }], reveal: null },
  })
  assert.equal(broker.mayAttachTerminal(window.id, 'terminal-a'), true)
  assert.equal(broker.mayAttachTerminal(window.id, 'terminal-b'), false, 'another tab’s pty is not the window’s')
  assert.equal(broker.mayAttachTerminal(workspaceWindow.id, 'terminal-a'), true, 'a window that is no pop-out')

  // Brought back while the window's own re-attach was still on its way.
  broker.push(owner, { popOutId: 'pop-1', state: { tabs: [{ id: 't2', kind: 'files' }], reveal: null } })
  assert.equal(broker.mayAttachTerminal(window.id, 'terminal-a'), false)

  broker.push(owner, {
    popOutId: 'pop-1',
    state: { tabs: [{ id: 't1', kind: 'terminal', terminalId: 'a' }], reveal: null },
  })
  broker.close(owner, { popOutId: 'pop-1' })
  assert.equal(window.closed, 1)
  assert.equal(broker.mayAttachTerminal(window.id, 'terminal-a'), false, 'a window being closed holds nothing')
})
