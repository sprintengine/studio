import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'vitest'

import type { ServerReady, SupervisorToServer } from '../../server/bootstrap/envelope'
import { SERVER_PORT_CHANNEL } from '../../shared/server-port'
import { createPortBroker, windowIdFromUrl, type BrokeredWindow } from './port-broker'
import type { SupervisorState } from './supervisor'

const APP = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

function fakePort(name: string) {
  return {
    name,
    closed: false,
    close() {
      this.closed = true
    },
  }
}

function fakeWindow(id: number, url: string) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    url,
    loading: false,
    destroyed: false,
    received: [] as Array<{ channel: string; message: unknown; ports: unknown[] }>,
    getURL() {
      return this.url
    },
    isDestroyed() {
      return this.destroyed
    },
    isLoading() {
      return this.loading
    },
    postMessage(channel: string, message: unknown, ports: unknown[]) {
      this.received.push({ channel, message, ports })
    },
  })
  const window = { isDestroyed: () => contents.destroyed, webContents: contents }
  return { window: window as unknown as BrokeredWindow, contents }
}

function fakeSupervisor() {
  const posted: Array<{ message: SupervisorToServer; transfer?: unknown[] }> = []
  const readyListeners: Array<(ready: ServerReady) => void> = []
  let state: SupervisorState = { kind: 'starting', attempt: 1 }
  return {
    posted,
    get state() {
      return state
    },
    post(message: SupervisorToServer, transfer?: unknown[]) {
      if (state.kind !== 'ready') return false
      posted.push({ message, transfer })
      return true
    },
    onReady(listener: (ready: ServerReady) => void) {
      readyListeners.push(listener)
      return () => undefined
    },
    becomeReady() {
      state = { kind: 'ready', ready: { t: 'ready' } as ServerReady }
      for (const listener of readyListeners) listener(state.ready)
    },
    stop() {
      state = { kind: 'backoff', attempt: 1, delayMs: 500, exit: { code: 70, signal: null } }
    },
  }
}

function setup() {
  const supervisor = fakeSupervisor()
  let channels = 0
  const broker = createPortBroker({
    supervisor,
    createChannel: () => {
      channels++
      return { port1: fakePort(`server-${channels}`), port2: fakePort(`window-${channels}`) } as never
    },
    isAppDocument: (url) => url.startsWith('file:') && url.includes('/renderer/index.html'),
    isWorkspaceWindow: (window) => window.webContents.getURL().includes('windowId='),
  })
  return { supervisor, broker }
}

test('a window that has loaded gets its port once the server is ready, and the server learns who it is', () => {
  const { supervisor, broker } = setup()
  const { window, contents } = fakeWindow(3, `${APP}?windowId=primary`)
  broker.attachWindow(window)
  assert.equal(supervisor.posted.length, 0, 'nothing to attach to yet')
  supervisor.becomeReady()
  assert.deepEqual(supervisor.posted[0].message, {
    t: 'attach-client',
    clientId: 'window-3-1',
    windowId: 'primary',
    kind: 'desktop-window',
    workspaceWindow: true,
  })
  assert.equal((supervisor.posted[0].transfer?.[0] as { name: string }).name, 'server-1')
  assert.equal(contents.received.length, 1)
  assert.equal(contents.received[0].channel, SERVER_PORT_CHANNEL)
  assert.deepEqual(contents.received[0].message, { clientId: 'window-3-1' })
  assert.equal((contents.received[0].ports[0] as { name: string }).name, 'window-1')
  assert.deepEqual(broker.attached(), ['window-3-1'])
})

test('a reload withdraws the port as it starts and brokers a new one when the document has loaded', () => {
  const { supervisor, broker } = setup()
  supervisor.becomeReady()
  const { window, contents } = fakeWindow(4, `${APP}?windowId=window-2`)
  broker.attachWindow(window)
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.deepEqual(supervisor.posted.at(-1)?.message, { t: 'detach-client', clientId: 'window-4-1' })
  // A link inside the page or a subframe navigating is not the document going.
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  assert.equal(supervisor.posted.length, 2)
  contents.emit('did-finish-load')
  assert.equal((supervisor.posted.at(-1)?.message as { clientId: string }).clientId, 'window-4-2')
})

test('a crashed renderer and a closed window end the window on the server', () => {
  const { supervisor, broker } = setup()
  supervisor.becomeReady()
  const { window, contents } = fakeWindow(5, `${APP}?windowId=primary`)
  broker.attachWindow(window)
  contents.emit('render-process-gone')
  assert.deepEqual(supervisor.posted.at(-1)?.message, { t: 'detach-client', clientId: 'window-5-1' })
  contents.emit('did-finish-load')
  contents.destroyed = true
  contents.emit('destroyed')
  assert.deepEqual(supervisor.posted.at(-1)?.message, { t: 'detach-client', clientId: 'window-5-2' })
  assert.deepEqual(broker.attached(), [])
})

test('a restarted server gets every window again on its ready', () => {
  const { supervisor, broker } = setup()
  supervisor.becomeReady()
  const a = fakeWindow(6, `${APP}?windowId=primary`)
  const b = fakeWindow(7, `${APP}?view=diagnostics`)
  broker.attachWindow(a.window)
  broker.attachWindow(b.window)
  supervisor.stop()
  supervisor.becomeReady()
  const attaches = supervisor.posted
    .map((entry) => entry.message)
    .filter((message): message is Extract<SupervisorToServer, { t: 'attach-client' }> => message.t === 'attach-client')
  assert.deepEqual(
    attaches.map((message) => [message.clientId, message.windowId, message.workspaceWindow]),
    [
      ['window-6-1', 'primary', true],
      ['window-7-1', null, false],
      ['window-6-2', 'primary', true],
      ['window-7-2', null, false],
    ],
  )
})

test('a document that is not the app gets no port, nor does one still loading', () => {
  const { supervisor, broker } = setup()
  supervisor.becomeReady()
  const worker = fakeWindow(
    8,
    'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/canvas-worker.html',
  )
  const away = fakeWindow(9, 'https://example.com/')
  const loading = fakeWindow(10, `${APP}?windowId=primary`)
  loading.contents.loading = true
  for (const each of [worker, away, loading]) broker.attachWindow(each.window)
  assert.equal(supervisor.posted.length, 0)
  for (const each of [worker, away, loading]) assert.equal(each.contents.received.length, 0)
})

test('a window that loads while the server is down waits for its ready', () => {
  const { supervisor, broker } = setup()
  const { window, contents } = fakeWindow(11, `${APP}?windowId=primary`)
  broker.attachWindow(window)
  contents.emit('did-finish-load')
  assert.equal(contents.received.length, 0)
  supervisor.becomeReady()
  assert.equal(contents.received.length, 1)
})

test('the window id is what main put in the query', () => {
  assert.equal(windowIdFromUrl(`${APP}?windowId=window-3&restoreDetached=0`), 'window-3')
  assert.equal(windowIdFromUrl(`${APP}`), null)
  assert.equal(windowIdFromUrl('not a url'), null)
})
