import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { serverModeFromArgv } from '../shared/server-mode'
import { createIpcRouter, ServerUnavailable, type RouterPort } from './ipc-router'

// The preload's router (phase 6 spec, 6.2): by table, a queue before the port,
// in-flight calls failed on a restart, idempotent reads sent again once, and
// everything to ipcRenderer in process.

const TABLE = {
  'launch-settings:get': { retry: 'once' as const },
  'launch-settings:update': {},
  'modules:registry-snapshot': {},
}

function fakeRenderer() {
  const calls: Array<[string, string, unknown[]]> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const renderer = {
    calls,
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push(['invoke', channel, args])
      return `main:${channel}`
    },
    send: (channel: string, ...args: unknown[]) => {
      calls.push(['send', channel, args])
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return renderer
    },
    once(channel: string, listener: (...args: unknown[]) => void) {
      return renderer.on(channel, listener)
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      listeners.get(channel)?.delete(listener)
      return renderer
    },
    removeAllListeners(channel: string) {
      listeners.delete(channel)
      return renderer
    },
    /** A push from main. */
    emit(channel: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({ sender: 'main' }, ...args)
    },
  }
  return renderer
}

function fakePort() {
  const listeners = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> }
  const port = {
    posted: [] as Array<Record<string, any>>,
    started: false,
    closed: false,
    postMessage(message: unknown) {
      port.posted.push(message as Record<string, any>)
    },
    addEventListener(type: 'message' | 'close', listener: any) {
      listeners[type].push(listener)
    },
    start() {
      port.started = true
    },
    close() {
      port.closed = true
    },
    /** What the server sends back. */
    deliver(data: unknown) {
      for (const listener of listeners.message) listener({ data })
    },
    /** The server went. */
    hangUp() {
      for (const listener of listeners.close) listener()
    },
  }
  return port
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('in process, every channel goes to main exactly as before', async () => {
  const renderer = fakeRenderer()
  const router = createIpcRouter({ ipcRenderer: renderer, mode: 'in-process', table: TABLE })
  assert.equal(await router.invoke('launch-settings:get'), 'main:launch-settings:get')
  router.send('modules:registry-snapshot', { modules: [] })
  assert.deepEqual(renderer.calls, [
    ['invoke', 'launch-settings:get', []],
    ['send', 'modules:registry-snapshot', [{ modules: [] }]],
  ])
})

test('out of process, a server channel goes over the port and a shell channel stays with main', async () => {
  const renderer = fakeRenderer()
  const router = createIpcRouter({ ipcRenderer: renderer, mode: 'out-of-process', table: TABLE })
  const port = fakePort()
  router.attachPort(port as unknown as RouterPort)
  assert.equal(port.started, true)
  const fromServer = router.invoke('launch-settings:update', { lastSelectedCli: 'codex' })
  const fromMain = router.invoke('terminal:list')
  const request = port.posted[0]
  assert.deepEqual(request, {
    t: 'ipc.invoke',
    id: request.id,
    channel: 'launch-settings:update',
    args: [{ lastSelectedCli: 'codex' }],
  })
  port.deliver({ t: 'ipc.result', id: request.id, ok: true, value: { ok: true } })
  assert.deepEqual(await fromServer, { ok: true })
  assert.equal(await fromMain, 'main:terminal:list')
  router.send('modules:registry-snapshot', 'snapshot')
  assert.deepEqual(port.posted.at(-1), { t: 'ipc.send', channel: 'modules:registry-snapshot', args: ['snapshot'] })
})

test("a server's refusal reads as Electron's own wording for a failed invoke", async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE })
  const port = fakePort()
  router.attachPort(port as unknown as RouterPort)
  const call = router.invoke('launch-settings:update', {})
  port.deliver({
    t: 'ipc.result',
    id: port.posted[0].id,
    ok: false,
    error: { name: 'Error', message: 'The settings are not writable.' },
  })
  await assert.rejects(call, {
    message: "Error invoking remote method 'launch-settings:update': Error: The settings are not writable.",
  })
})

test('before the port arrives, server calls wait, then go out in order', async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE })
  const first = router.invoke('launch-settings:get')
  const second = router.invoke('launch-settings:update', 1)
  router.send('modules:registry-snapshot', 'early')
  await vi.advanceTimersByTimeAsync(5_000)
  const port = fakePort()
  router.attachPort(port as unknown as RouterPort)
  assert.deepEqual(
    port.posted.map((frame) => frame.channel),
    ['launch-settings:get', 'launch-settings:update', 'modules:registry-snapshot'],
  )
  for (const frame of port.posted.filter((each) => each.t === 'ipc.invoke')) {
    port.deliver({ t: 'ipc.result', id: frame.id, ok: true, value: frame.channel })
  }
  assert.equal(await first, 'launch-settings:get')
  assert.equal(await second, 'launch-settings:update')
  // The queue's timers went with it.
  await vi.advanceTimersByTimeAsync(60_000)
})

test('a call that waits 30 s for a server fails with ServerUnavailable', async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE })
  const call = router.invoke('launch-settings:get')
  const failed = assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof ServerUnavailable)
    assert.equal(error.restarting, false)
    assert.match(error.message, /did not start in time/)
    return true
  })
  await vi.advanceTimersByTimeAsync(30_000)
  await failed
})

test('the queue holds 256 calls; the next is refused at once', async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE, queueLimit: 2 })
  void router.invoke('launch-settings:get').catch(() => undefined)
  void router.invoke('launch-settings:get').catch(() => undefined)
  await assert.rejects(router.invoke('launch-settings:get'), /Too many requests/)
})

test('a restart fails what was in flight, except the reads marked to retry, which go out on the next port', async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE })
  const first = fakePort()
  router.attachPort(first as unknown as RouterPort)
  const read = router.invoke('launch-settings:get')
  const write = router.invoke('launch-settings:update', { x: 1 })
  first.hangUp()
  await assert.rejects(write, (error: unknown) => error instanceof ServerUnavailable && error.restarting)
  const second = fakePort()
  router.attachPort(second as unknown as RouterPort)
  assert.deepEqual(
    second.posted.map((frame) => frame.channel),
    ['launch-settings:get'],
  )
  second.deliver({ t: 'ipc.result', id: second.posted[0].id, ok: true, value: 'read again' })
  assert.equal(await read, 'read again')
})

test('a read retried once is not retried twice', async () => {
  const router = createIpcRouter({ ipcRenderer: fakeRenderer(), mode: 'out-of-process', table: TABLE })
  const first = fakePort()
  router.attachPort(first as unknown as RouterPort)
  const read = router.invoke('launch-settings:get')
  first.hangUp()
  const second = fakePort()
  router.attachPort(second as unknown as RouterPort)
  second.hangUp()
  await assert.rejects(read, (error: unknown) => error instanceof ServerUnavailable && error.restarting)
})

test('listeners hear pushes from main and from the server, and stop when removed', () => {
  const renderer = fakeRenderer()
  const router = createIpcRouter({ ipcRenderer: renderer, mode: 'out-of-process', table: TABLE })
  const port = fakePort()
  router.attachPort(port as unknown as RouterPort)
  const heard: unknown[] = []
  const listener = (event: unknown, payload: unknown) => heard.push([(event as { sender: unknown }).sender, payload])
  router.on('launch-settings:changed', listener as never)
  renderer.emit('launch-settings:changed', 'from main')
  port.deliver({ t: 'ipc.push', channel: 'launch-settings:changed', args: ['from server'] })
  router.removeListener('launch-settings:changed', listener as never)
  renderer.emit('launch-settings:changed', 'after')
  port.deliver({ t: 'ipc.push', channel: 'launch-settings:changed', args: ['after'] })
  assert.deepEqual(heard, [
    ['main', 'from main'],
    [null, 'from server'],
  ])
})

test('a listener added once hears one push, from either side', () => {
  const renderer = fakeRenderer()
  const router = createIpcRouter({ ipcRenderer: renderer, mode: 'out-of-process', table: TABLE })
  const port = fakePort()
  router.attachPort(port as unknown as RouterPort)
  const heard: unknown[] = []
  router.once('hosts:changed', ((_event: unknown, payload: unknown) => heard.push(payload)) as never)
  port.deliver({ t: 'ipc.push', channel: 'hosts:changed', args: ['first'] })
  renderer.emit('hosts:changed', 'second')
  assert.deepEqual(heard, ['first'])
})

test("a renderer's mode is the switch main put on its command line", () => {
  assert.equal(serverModeFromArgv(['electron', '--studio-server-mode=out-of-process']), 'out-of-process')
  assert.equal(serverModeFromArgv(['electron', '--studio-server-mode=nonsense']), 'in-process')
  assert.equal(serverModeFromArgv(['electron']), 'in-process')
})
