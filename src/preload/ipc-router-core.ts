import type { IpcRendererEvent } from 'electron'

import { SERVER_IPC_CHANNELS, type ServerIpcChannel } from '../shared/ipc-channel-owners'
import { SERVER_UNAVAILABLE_ERROR } from '../shared/server-port'
import type { ServerMode } from '../shared/server-mode'

// The preload's IPC, routed by who owns the channel (phase 6 spec, 6.2). Every
// api module imports `ipc` from `ipc-router` instead of `ipcRenderer` from
// Electron and calls it the same way. The router itself is here, with nothing
// of Electron at runtime, so the web client builds the same router over a
// browser's socket (src/renderer/src/web/webIpcRouter.ts).
//
// In process (the default) everything goes to `ipcRenderer`, exactly as
// before. Out of process, a channel the server owns (SERVER_IPC_CHANNELS) goes
// over this window's port to the server, which main hands the preload on
// `studio-server:port`; every other channel stays with main. Listeners hear
// both: a push arrives from whichever process owns its domain, so nothing has
// to say which one a push channel belongs to.
//
// Before the port arrives, invokes on server channels wait in a queue (256 at
// most, 30 s each). When the port closes (the server restarted), what was in
// flight fails with `ServerUnavailable { restarting: true }`, except the reads
// marked `retry: 'once'`, which go out again on the next port.

export type RendererIpc = {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): RendererIpc
  once(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): RendererIpc
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): RendererIpc
  removeAllListeners(channel: string): RendererIpc
}

/** The renderer end of a port: the web's `MessagePort`. */
export type RouterPort = {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: () => void): void
  start(): void
  close(): void
}

/** A failed call on a server channel: the server is not there (yet, or any more). */
export class ServerUnavailable extends Error {
  readonly restarting: boolean
  constructor(channel: string, reason: string, restarting: boolean) {
    super(`Error invoking remote method '${channel}': ${SERVER_UNAVAILABLE_ERROR}: ${reason}`)
    this.name = SERVER_UNAVAILABLE_ERROR
    this.restarting = restarting
  }
}

/** The slice of Electron's `ipcRenderer` the router drives, so a test can hand in its own. */
type ElectronIpcLike = {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: any[]) => void): unknown
  removeListener(channel: string, listener: (...args: any[]) => void): unknown
  removeAllListeners(channel: string): unknown
}

export type IpcRouterOptions = {
  ipcRenderer: ElectronIpcLike
  mode: ServerMode
  table?: Readonly<Record<string, ServerIpcChannel>>
  queueLimit?: number
  queueTimeoutMs?: number
}

type Listener = (event: IpcRendererEvent, ...args: any[]) => void

type Pending = {
  id: number
  channel: string
  args: unknown[]
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

const QUEUE_LIMIT = 256
const QUEUE_TIMEOUT_MS = 30_000

// What a listener is handed for a push that came over the port: Electron's
// event has a sender and ports; a server push has neither.
const PORT_EVENT = Object.freeze({ sender: null, senderId: 0, ports: [] }) as unknown as IpcRendererEvent

export function createIpcRouter(options: IpcRouterOptions): RendererIpc & {
  /** Hand the router this window's port (main's broker does it through `studio-server:port`). */
  attachPort(port: RouterPort): void
} {
  const renderer = options.ipcRenderer
  const table = options.table ?? SERVER_IPC_CHANNELS
  const queueLimit = options.queueLimit ?? QUEUE_LIMIT
  const queueTimeoutMs = options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS
  const listeners = new Map<string, Set<Listener>>()
  const onceWrappers = new Map<Listener, Listener>()
  const queued: Pending[] = []
  const queuedSends: Array<{ channel: string; args: unknown[] }> = []
  const inFlight = new Map<number, Pending>()
  let port: RouterPort | null = null
  let nextId = 1

  const routesToServer = (channel: string): boolean =>
    options.mode === 'out-of-process' && Object.hasOwn(table, channel)

  function addListener(channel: string, listener: Listener): void {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    set.add(listener)
  }

  function dispatchPush(channel: string, args: unknown[]): void {
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      try {
        listener(PORT_EVENT, ...args)
      } catch (error) {
        console.error(`[ipc-router] a listener on ${channel} threw`, error)
      }
    }
  }

  function startTimer(entry: Pending): void {
    entry.timer = setTimeout(() => {
      const index = queued.indexOf(entry)
      if (index >= 0) queued.splice(index, 1)
      entry.reject(new ServerUnavailable(entry.channel, 'Studio server did not start in time.', false))
    }, queueTimeoutMs)
  }

  function transmit(entry: Pending): void {
    if (!port) {
      queued.push(entry)
      startTimer(entry)
      return
    }
    inFlight.set(entry.id, entry)
    port.postMessage({ t: 'ipc.invoke', id: entry.id, channel: entry.channel, args: entry.args })
  }

  function onPortMessage(data: unknown): void {
    const frame = data as {
      t?: unknown
      id?: unknown
      ok?: unknown
      value?: unknown
      error?: { name?: unknown; message?: unknown }
      channel?: unknown
      args?: unknown
    } | null
    if (frame?.t === 'ipc.result' && typeof frame.id === 'number') {
      const entry = inFlight.get(frame.id)
      if (!entry) return
      inFlight.delete(frame.id)
      if (frame.ok) entry.resolve(frame.value)
      else {
        const name = typeof frame.error?.name === 'string' ? frame.error.name : 'Error'
        const message = typeof frame.error?.message === 'string' ? frame.error.message : 'Failed.'
        // Electron's own wording for a rejected invoke, so code that reads it reads the same.
        const error = new Error(`Error invoking remote method '${entry.channel}': ${name}: ${message}`)
        entry.reject(error)
      }
      return
    }
    if (frame?.t === 'ipc.push' && typeof frame.channel === 'string') {
      dispatchPush(frame.channel, Array.isArray(frame.args) ? frame.args : [])
    }
  }

  function onPortClosed(closed: RouterPort): void {
    if (port !== closed) return
    port = null
    for (const entry of [...inFlight.values()]) {
      inFlight.delete(entry.id)
      if (table[entry.channel]?.retry === 'once' && !(entry as { retried?: boolean }).retried) {
        ;(entry as { retried?: boolean }).retried = true
        queued.push(entry)
        startTimer(entry)
      } else {
        entry.reject(new ServerUnavailable(entry.channel, 'Studio server restarted.', true))
      }
    }
  }

  const router = {
    invoke(channel: string, ...args: unknown[]): Promise<any> {
      if (!routesToServer(channel)) return renderer.invoke(channel, ...args)
      if (!port && queued.length >= queueLimit) {
        return Promise.reject(new ServerUnavailable(channel, 'Too many requests are waiting for Studio server.', false))
      }
      return new Promise((resolve, reject) => {
        transmit({ id: nextId++, channel, args, resolve, reject, timer: null })
      })
    },
    send(channel: string, ...args: unknown[]): void {
      if (!routesToServer(channel)) {
        renderer.send(channel, ...args)
        return
      }
      if (port) port.postMessage({ t: 'ipc.send', channel, args })
      else if (queuedSends.length < queueLimit) queuedSends.push({ channel, args })
    },
    on(channel: string, listener: Listener) {
      addListener(channel, listener)
      renderer.on(channel, listener)
      return router
    },
    once(channel: string, listener: Listener) {
      const wrapped: Listener = (event, ...args) => {
        router.removeListener(channel, listener)
        listener(event, ...args)
      }
      onceWrappers.set(listener, wrapped)
      addListener(channel, wrapped)
      renderer.on(channel, wrapped)
      return router
    },
    removeListener(channel: string, listener: Listener) {
      const wrapped = onceWrappers.get(listener)
      for (const each of wrapped ? [listener, wrapped] : [listener]) {
        listeners.get(channel)?.delete(each)
        renderer.removeListener(channel, each)
      }
      onceWrappers.delete(listener)
      return router
    },
    removeAllListeners(channel: string) {
      listeners.delete(channel)
      renderer.removeAllListeners(channel)
      return router
    },
    attachPort(next: RouterPort) {
      if (port && port !== next) {
        // A new port before the old one said it closed (main brokers again
        // while the old port's close is still on its way): what was in flight
        // on the old one is settled now, as for a close, since its close
        // event will find another port in place and do nothing.
        const previous = port
        onPortClosed(previous)
        previous.close()
      }
      port = next
      next.addEventListener('message', (event) => onPortMessage(event.data))
      next.addEventListener('close', () => onPortClosed(next))
      next.start()
      for (const entry of queued.splice(0)) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = null
        transmit(entry)
      }
      for (const send of queuedSends.splice(0))
        next.postMessage({ t: 'ipc.send', channel: send.channel, args: send.args })
    },
  }
  return router
}
