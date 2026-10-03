import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import { registerMeshIpc } from '../../main/ipc/mesh-ipc'
import { MESH_CONVERSATION_FOLLOW_CHANNEL } from '../../shared/tailnet-mesh'
import { registerWorkspaceSyncIpc } from '../../main/ipc/workspace-sync-ipc'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import { createIpcTunnel, IpcSenderUnavailable, type TunnelClient, type TunnelPort } from './ipc-tunnel'

/** A window's end of its port, as the preload holds it, wired to the server's end. */
function portPair() {
  const serverListeners = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> }
  const received: Array<Record<string, any>> = []
  let open = true
  const server: TunnelPort & { closed: boolean } = {
    closed: false,
    postMessage(message) {
      if (open) received.push(structuredClone(message) as Record<string, any>)
    },
    on(event: 'message' | 'close', listener: any) {
      serverListeners[event].push(listener)
      return server
    },
    start() {},
    close() {
      server.closed = true
      open = false
    },
  }
  return {
    server,
    received,
    /** What the window sends. */
    send(frame: unknown) {
      for (const listener of serverListeners.message) listener({ data: structuredClone(frame) })
    },
    /** The window went away. */
    hangUp() {
      open = false
      for (const listener of serverListeners.close) listener()
    },
    async result(id: number): Promise<Record<string, any>> {
      for (let tries = 0; tries < 200; tries++) {
        const found = received.find((frame) => frame.t === 'ipc.result' && frame.id === id)
        if (found) return found
        await new Promise((resolve) => setImmediate(resolve))
      }
      throw new Error(`no result for ${id}`)
    },
  }
}

const client = (clientId: string, overrides: Partial<TunnelClient> = {}): TunnelClient => ({
  clientId,
  windowId: 'primary',
  kind: 'desktop-window',
  workspaceWindow: true,
  ...overrides,
})

test('an invoke is answered with what the handler returns, sync or async', async () => {
  const tunnel = createIpcTunnel()
  tunnel.registry.handle('launch-settings:get', () => ({ lastSelectedCli: 'claude' }))
  tunnel.registry.handle('hosts:list', async (_event, filter: string) => [`${filter}-local`])
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'launch-settings:get', args: [] })
  window.send({ t: 'ipc.invoke', id: 2, channel: 'hosts:list', args: ['all'] })
  assert.deepEqual(await window.result(1), { t: 'ipc.result', id: 1, ok: true, value: { lastSelectedCli: 'claude' } })
  assert.deepEqual((await window.result(2)).value, ['all-local'])
})

test('a handler that throws answers as itself failing, and a channel nobody serves says so', async () => {
  const tunnel = createIpcTunnel()
  tunnel.registry.handle('credential:set', () => {
    throw new TypeError('Provider id is invalid.')
  })
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'credential:set', args: [] })
  window.send({ t: 'ipc.invoke', id: 2, channel: 'nothing:here', args: [] })
  assert.deepEqual((await window.result(1)).error, { name: 'TypeError', message: 'Provider id is invalid.' })
  assert.match((await window.result(2)).error.message, /No handler registered for 'nothing:here'/)
})

test('a handler hears who asked', async () => {
  const tunnel = createIpcTunnel()
  tunnel.registry.handle('who', (event) => event.caller)
  const window = portPair()
  tunnel.attach(client('w7', { windowId: 'window-2' }), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'who', args: [] })
  assert.deepEqual((await window.result(1)).value, { clientId: 'w7', windowId: 'window-2', kind: 'desktop-window' })
})

test('a send reaches every listener on its channel', () => {
  const tunnel = createIpcTunnel()
  const heard: unknown[] = []
  tunnel.registry.on('modules:registry-snapshot', (event, snapshot) => heard.push([event.caller.clientId, snapshot]))
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({ t: 'ipc.send', channel: 'modules:registry-snapshot', args: [{ modules: [] }] })
  assert.deepEqual(heard, [['w1', { modules: [] }]])
})

test('pushes reach the clients a target names', () => {
  const tunnel = createIpcTunnel()
  const [a, b, aux] = [portPair(), portPair(), portPair()]
  tunnel.attach(client('a'), a.server)
  tunnel.attach(client('b'), b.server)
  tunnel.attach(client('aux', { workspaceWindow: false, windowId: null }), aux.server)
  const pushed = (port: ReturnType<typeof portPair>) =>
    port.received.filter((frame) => frame.t === 'ipc.push').map((frame) => frame.args[0])

  tunnel.publish('topic', 'all')
  tunnel.bus.publish('topic', 'workspace', 'workspace-windows')
  tunnel.publish('topic', 'only-b', { clientId: 'b' })
  tunnel.publish('topic', 'not-a', { exceptClientId: 'a' })
  assert.deepEqual(pushed(a), ['all', 'workspace'])
  assert.deepEqual(pushed(b), ['all', 'workspace', 'only-b', 'not-a'])
  assert.deepEqual(pushed(aux), ['all', 'not-a'])
})

test('a window that goes ends what it subscribed to, and an answer for it is dropped', async () => {
  const tunnel = createIpcTunnel()
  const released: number[] = []
  let finish: (value: string) => void = () => undefined
  tunnel.registry.handle('subscribe', (event) => {
    event.sender.once('destroyed', () => released.push(event.sender.id))
    return event.sender.id
  })
  tunnel.registry.handle('slow', () => new Promise((resolve) => (finish = resolve)))
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'subscribe', args: [] })
  const senderId = (await window.result(1)).value
  window.send({ t: 'ipc.invoke', id: 2, channel: 'slow', args: [] })
  window.hangUp()
  finish('late')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(released, [senderId])
  assert.equal(
    window.received.some((frame) => frame.id === 2),
    false,
  )
  assert.deepEqual(tunnel.clients(), [])
})

test('a detach from the shell (a reload, a crashed renderer) closes the port and releases the same way', async () => {
  const tunnel = createIpcTunnel()
  let destroyed = false
  tunnel.registry.handle('follow', (event) => {
    event.sender.on('destroyed', () => (destroyed = true))
    return true
  })
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'follow', args: [] })
  await window.result(1)
  tunnel.detach('w1')
  assert.equal(destroyed, true)
  assert.equal(window.server.closed, true)
})

test('a client attached again under its id replaces the first', async () => {
  const tunnel = createIpcTunnel()
  const releases: string[] = []
  tunnel.registry.handle('track', (event) => {
    event.sender.once('destroyed', () => releases.push(event.caller.clientId))
  })
  const first = portPair()
  tunnel.attach(client('w1'), first.server)
  first.send({ t: 'ipc.invoke', id: 1, channel: 'track', args: [] })
  await first.result(1)
  tunnel.attach(client('w1'), portPair().server)
  assert.deepEqual(releases, ['w1'])
  assert.equal(first.server.closed, true)
})

test('a handler that reaches for more of the window than the tunnel has fails by name', async () => {
  const tunnel = createIpcTunnel()
  const logged: string[] = []
  const logging = createIpcTunnel({ log: (message) => logged.push(message) })
  for (const each of [tunnel, logging]) {
    each.registry.handle('workspace-sync:dispatch', (event) =>
      (event.sender as unknown as { getURL(): string }).getURL(),
    )
  }
  const window = portPair()
  logging.attach(client('w1'), window.server)
  window.send({ t: 'ipc.invoke', id: 1, channel: 'workspace-sync:dispatch', args: [] })
  const answer = await window.result(1)
  assert.equal(answer.ok, false)
  assert.equal(answer.error.name, 'IpcSenderUnavailable')
  assert.match(answer.error.message, /workspace-sync:dispatch reached for the window's getURL/)
  assert.match(logged.join('\n'), /getURL/)
  assert.ok(new IpcSenderUnavailable('x', 'y') instanceof Error)
})

test('a channel registered twice is refused where it is wired', () => {
  const tunnel = createIpcTunnel()
  tunnel.registry.handle('once', () => undefined)
  assert.throws(() => tunnel.registry.handle('once', () => undefined), /second handler for 'once'/)
  tunnel.registry.removeHandler('once')
  tunnel.registry.handle('once', () => undefined)
  assert.deepEqual(tunnel.channels(), ['once'])
})

test('the workspace bus moves verbatim: a dispatch reaches every workspace window but its own', async () => {
  const tunnel = createIpcTunnel()
  const registry = createWorkspaceRegistryService({ store: createInMemoryWorkspaceRegistryStore() })
  const service = createWorkspaceSyncService({ registry })
  registerWorkspaceSyncIpc(tunnel.registry as unknown as IpcMain, service, {
    registry,
    listWindows: () => tunnel.windows('workspace-windows') as never,
    getSourceWindowId: (event) =>
      (event as unknown as { caller: { windowId: string | null } }).caller.windowId ?? 'primary',
  })
  const [source, other, aux] = [portPair(), portPair(), portPair()]
  tunnel.attach(client('source', { windowId: 'primary' }), source.server)
  tunnel.attach(client('other', { windowId: 'window-2' }), other.server)
  tunnel.attach(client('aux', { workspaceWindow: false, windowId: null }), aux.server)
  source.send({
    t: 'ipc.invoke',
    id: 1,
    channel: 'workspace-sync:dispatch',
    args: [
      {
        type: 'workspace_window.update_placement',
        payload: { windowId: 'primary', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMaximized: false },
      },
    ],
  })
  const result = await source.result(1)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.ok, true, JSON.stringify(result.value))
  const events = (port: ReturnType<typeof portPair>) =>
    port.received.filter((frame) => frame.t === 'ipc.push' && frame.channel === 'workspace-sync:event')
  assert.equal(events(source).length, 0, 'the window that dispatched already shows it')
  assert.equal(events(other).length, 1)
  assert.equal(events(aux).length, 0)
})

test('a followed conversation on another machine ends with the window that followed it', async () => {
  const tunnel = createIpcTunnel()
  const unfollowed: unknown[] = []
  const mesh = {
    followConversation: () => ({ ok: true }),
    unfollowConversation: (followId: unknown) => unfollowed.push(followId),
  }
  registerMeshIpc(tunnel.registry as unknown as IpcMain, { mesh: () => mesh } as never)
  const window = portPair()
  tunnel.attach(client('w1'), window.server)
  window.send({
    t: 'ipc.invoke',
    id: 1,
    channel: MESH_CONVERSATION_FOLLOW_CHANNEL,
    args: [{ followId: 'f1', key: { workspaceId: 'ws', agentId: 'a' } }],
  })
  const answer = await window.result(1)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  window.hangUp()
  assert.deepEqual(unfollowed, ['f1'])
})
