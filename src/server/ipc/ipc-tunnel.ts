import type { ClientBus, ClientTarget } from '../platform/client-bus'

// The legacy IPC tunnel (phase 6 spec, section 6.2): the `window.api` channels
// of the domains the server owns, carried unchanged over each window's port, so
// their `registerXIpc(ipcMain, …)` moves into the server verbatim and only the
// registry it is handed changes.
//
// Frames on a window's port, as structured clones (Electron's IPC clones the
// same way, so a value that crossed before crosses now):
//
//   window → server  { t: 'ipc.invoke', id, channel, args }
//                    { t: 'ipc.send', channel, args }
//   server → window  { t: 'ipc.result', id, ok: true, value } | { …, ok: false, error }
//                    { t: 'ipc.push', channel, args }
//
// A handler's first argument is shaped like Electron's event: `caller` says who
// asked (the client, its window), and `sender` stands in for the WebContents
// with the part of it the tunnelled domains use — an id, `send`, `isDestroyed`,
// and the `destroyed` event, fired when the window's port goes (a closed
// window, a reload, a crashed renderer). Anything else on it throws
// `IpcSenderUnavailable` naming the channel, so a handler that still reaches
// for the window itself fails loudly in a test rather than quietly doing
// nothing in the server.

export type CallerKind = 'desktop-window' | 'web-tab' | 'shell'

/** Who sent a tunnelled request. */
export type CallerContext = {
  /** The window port's id: subscriptions keyed by it end when the port closes. */
  clientId: string
  /** From the window's URL query, asserted by main when it attached the port. */
  windowId: string | null
  kind: CallerKind
}

/** The WebContents members a tunnelled handler may use. */
export type TunnelSender = {
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  on(event: 'destroyed' | 'did-navigate', listener: () => void): TunnelSender
  once(event: 'destroyed' | 'did-navigate', listener: () => void): TunnelSender
  off(event: 'destroyed' | 'did-navigate', listener: () => void): TunnelSender
  removeListener(event: 'destroyed' | 'did-navigate', listener: () => void): TunnelSender
}

/** The first argument a tunnelled handler receives. */
export type TunnelEvent = { readonly caller: CallerContext; readonly sender: TunnelSender }

export class IpcSenderUnavailable extends Error {
  constructor(channel: string, member: string) {
    super(
      `${channel} reached for the window's ${member}, which the Studio server does not have. ` +
        'Use the caller context (clientId, windowId) or a ClientBus target instead.',
    )
    this.name = 'IpcSenderUnavailable'
  }
}

/** `ipcMain`'s shape, so a domain's registration moves into the server unchanged. */
export type ServerIpcRegistry = {
  handle(channel: string, handler: (event: TunnelEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: TunnelEvent, ...args: any[]) => void): void
  removeHandler(channel: string): void
  removeListener(channel: string, listener: (event: TunnelEvent, ...args: any[]) => void): void
}

/** The end of a window's port the server holds: Electron's `MessagePortMain` in a utility process. */
export type TunnelPort = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

export type TunnelClient = CallerContext & {
  /** A workspace window (not Diagnostics, not an aux view): the `workspace-windows` target. */
  workspaceWindow: boolean
}

export type IpcTunnel = {
  registry: ServerIpcRegistry
  attach(client: TunnelClient, port: TunnelPort): void
  /** The window went (closed, reloaded, crashed): its port is closed and its subscriptions end. */
  detach(clientId: string): void
  publish(channel: string, payload: unknown, target?: ClientTarget): void
  clients(): TunnelClient[]
  /** The stand-in WebContents of each attached client, for a domain that broadcasts through window objects. */
  windows(target?: ClientTarget): Array<{ isDestroyed(): boolean; webContents: TunnelSender }>
  /** Handlers registered, for the completeness test. */
  channels(): string[]
  /** The tunnel as the platform's client bus: a published topic is a push on that channel. */
  bus: ClientBus
}

type Attached = { client: TunnelClient; port: TunnelPort; sender: TunnelSender & { destroy(): void } }

type Handler = (event: TunnelEvent, ...args: unknown[]) => unknown
type Listener = (event: TunnelEvent, ...args: unknown[]) => void

export function createIpcTunnel(options: { log?: (message: string) => void } = {}): IpcTunnel {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<Listener>>()
  const attached = new Map<string, Attached>()
  let nextSenderId = 1

  const registry: ServerIpcRegistry = {
    handle(channel, handler) {
      // Electron refuses a second handler for a channel; so does the tunnel,
      // so a domain registered twice fails where it is wired.
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, handler as Handler)
    },
    on(channel, listener) {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener as Listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener as Listener)
    },
  }

  function post(entry: Attached, message: unknown): void {
    try {
      entry.port.postMessage(message)
    } catch (error) {
      options.log?.(
        `push to ${entry.client.clientId} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  function makeSender(clientId: string): Attached['sender'] {
    const id = nextSenderId++
    let destroyed = false
    const events = new Map<string, Set<() => void>>()
    const add = (event: string, listener: () => void, once: boolean) => {
      let set = events.get(event)
      if (!set) events.set(event, (set = new Set()))
      if (once) {
        const wrapped = () => {
          set.delete(wrapped)
          listener()
        }
        ;(wrapped as { listener?: () => void }).listener = listener
        set.add(wrapped)
      } else set.add(listener)
    }
    const remove = (event: string, listener: () => void) => {
      const set = events.get(event)
      if (!set) return
      for (const entry of set) {
        if (entry === listener || (entry as { listener?: () => void }).listener === listener) set.delete(entry)
      }
    }
    const sender: Attached['sender'] = {
      id,
      send(channel, ...args) {
        const entry = attached.get(clientId)
        if (!destroyed && entry) post(entry, { t: 'ipc.push', channel, args })
      },
      isDestroyed: () => destroyed,
      on(event, listener) {
        add(event, listener, false)
        return sender
      },
      once(event, listener) {
        add(event, listener, true)
        return sender
      },
      off(event, listener) {
        remove(event, listener)
        return sender
      },
      removeListener(event, listener) {
        remove(event, listener)
        return sender
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        for (const listener of [...(events.get('destroyed') ?? [])]) {
          try {
            listener()
          } catch (error) {
            options.log?.(`a release on ${clientId} threw: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        events.clear()
      },
    }
    return sender
  }

  /** The handler's view of the sender: the members above, and a loud failure for any other. */
  function guardedSender(sender: TunnelSender, channel: string): TunnelSender {
    return new Proxy(sender, {
      get(target, property, receiver) {
        if (typeof property === 'symbol' || property in target) return Reflect.get(target, property, receiver)
        throw new IpcSenderUnavailable(channel, String(property))
      },
    })
  }

  function eventFor(entry: Attached, channel: string): TunnelEvent {
    const { workspaceWindow: _workspaceWindow, ...caller } = entry.client
    return { caller, sender: guardedSender(entry.sender, channel) }
  }

  async function invoke(entry: Attached, id: unknown, channel: unknown, args: unknown): Promise<void> {
    if (typeof channel !== 'string') return
    const handler = handlers.get(channel)
    let reply: unknown
    if (!handler) {
      reply = {
        t: 'ipc.result',
        id,
        ok: false,
        error: { name: 'Error', message: `No handler registered for '${channel}'` },
      }
    } else {
      try {
        const value = await handler(eventFor(entry, channel), ...(Array.isArray(args) ? args : []))
        reply = { t: 'ipc.result', id, ok: true, value }
      } catch (error) {
        if (error instanceof IpcSenderUnavailable) options.log?.(error.message)
        reply = {
          t: 'ipc.result',
          id,
          ok: false,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    if (attached.get(entry.client.clientId) === entry) post(entry, reply)
  }

  function deliver(entry: Attached, channel: unknown, args: unknown): void {
    if (typeof channel !== 'string') return
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      try {
        listener(eventFor(entry, channel), ...(Array.isArray(args) ? args : []))
      } catch (error) {
        options.log?.(`${channel} listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function matches(client: TunnelClient, target: ClientTarget): boolean {
    if (target === 'all') return true
    if (target === 'workspace-windows') return client.workspaceWindow
    if ('clientId' in target) return client.clientId === target.clientId
    return client.clientId !== target.exceptClientId
  }

  function publish(channel: string, payload: unknown, target: ClientTarget = 'all'): void {
    for (const entry of attached.values()) {
      if (matches(entry.client, target)) post(entry, { t: 'ipc.push', channel, args: [payload] })
    }
  }

  function detach(clientId: string): void {
    const entry = attached.get(clientId)
    if (!entry) return
    attached.delete(clientId)
    entry.sender.destroy()
    try {
      entry.port.close()
    } catch {
      // Already closed: that is often why it is being detached.
    }
  }

  return {
    registry,
    attach(client, port) {
      // A client id is attached once; a second attach replaces the first, whose
      // subscriptions end as for a reload.
      detach(client.clientId)
      const entry: Attached = { client, port, sender: makeSender(client.clientId) }
      attached.set(client.clientId, entry)
      port.on('message', (event) => {
        if (attached.get(client.clientId) !== entry) return
        const frame = event.data as { t?: unknown; id?: unknown; channel?: unknown; args?: unknown } | null
        if (frame?.t === 'ipc.invoke') void invoke(entry, frame.id, frame.channel, frame.args)
        else if (frame?.t === 'ipc.send') deliver(entry, frame.channel, frame.args)
      })
      port.on('close', () => {
        if (attached.get(client.clientId) === entry) detach(client.clientId)
      })
      port.start()
    },
    detach,
    publish,
    clients: () => [...attached.values()].map((entry) => entry.client),
    windows(target = 'all') {
      return [...attached.values()]
        .filter((entry) => matches(entry.client, target))
        .map((entry) => ({ isDestroyed: () => entry.sender.isDestroyed(), webContents: entry.sender }))
    },
    channels: () => [...new Set([...handlers.keys(), ...listeners.keys()])].sort(),
    bus: { publish: (channel, payload, target) => publish(channel, payload, target) },
  }
}
