import type { MessagePortMain, WebContents } from 'electron'

import { SERVER_PORT_CHANNEL } from '../../shared/server-port'
import type { ServerSupervisor } from './supervisor'

// One message port per window to the Studio server (phase 6 spec, decision
// D2). Main is the broker it trusts: it makes the channel, hands one end to
// the server with who the window is, and the other to that window's preload.
// The port is the window's identity, so only an app window's own top-level
// document is given one: never the canvas worker, a webview guest or a page
// the window navigated away to.
//
// A window's port is brokered when its document has loaded, and again after
// every reload and every server restart; it is withdrawn the moment the
// document goes (a navigation, a crashed renderer, a closed window), which
// ends that window's subscriptions on the server.

type MessageChannelLike = { port1: MessagePortMain; port2: MessagePortMain }

/** The window members the broker reads. */
export type BrokeredWindow = {
  isDestroyed(): boolean
  webContents: Pick<WebContents, 'id' | 'getURL' | 'isDestroyed' | 'isLoading' | 'postMessage' | 'on' | 'off'>
}

export type PortBrokerDeps = {
  supervisor: Pick<ServerSupervisor, 'post' | 'onReady' | 'state'>
  createChannel: () => MessageChannelLike
  /** The app's own renderer document, as `isAppSender` decides it. */
  isAppDocument: (url: string) => boolean
  isWorkspaceWindow: (window: BrokeredWindow) => boolean
  log?: (line: string) => void
}

export type PortBroker = {
  /** Broker a port to this window now (when it has loaded), and after each reload and restart. */
  attachWindow(window: BrokeredWindow): void
  /** The windows holding a port now, by client id (diagnostics and tests). */
  attached(): string[]
}

export function createPortBroker(deps: PortBrokerDeps): PortBroker {
  const windows = new Map<number, { window: BrokeredWindow; clientId: string | null; generation: number }>()

  function detach(entry: { clientId: string | null }): void {
    if (!entry.clientId) return
    deps.supervisor.post({ t: 'detach-client', clientId: entry.clientId })
    entry.clientId = null
  }

  function broker(id: number): void {
    const entry = windows.get(id)
    if (!entry) return
    const { window } = entry
    if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoading()) return
    if (deps.supervisor.state.kind !== 'ready') return
    const url = window.webContents.getURL()
    if (!deps.isAppDocument(url)) return
    detach(entry)
    entry.generation++
    const clientId = `window-${id}-${entry.generation}`
    const { port1, port2 } = deps.createChannel()
    const delivered = deps.supervisor.post(
      {
        t: 'attach-client',
        clientId,
        windowId: windowIdFromUrl(url),
        kind: 'desktop-window',
        workspaceWindow: deps.isWorkspaceWindow(window),
      },
      [port1],
    )
    if (!delivered) {
      port1.close()
      port2.close()
      return
    }
    entry.clientId = clientId
    window.webContents.postMessage(SERVER_PORT_CHANNEL, { clientId }, [port2])
    deps.log?.(`brokered ${clientId}`)
  }

  // Every restart's ready brokers every window again: the old ports died with the old server.
  deps.supervisor.onReady(() => {
    for (const [id, entry] of windows) {
      entry.clientId = null
      broker(id)
    }
  })

  return {
    attachWindow(window) {
      const id = window.webContents.id
      if (windows.has(id)) return
      const entry = { window, clientId: null as string | null, generation: 0 }
      windows.set(id, entry)
      const contents = window.webContents
      const loaded = () => broker(id)
      const gone = () => detach(entry)
      const navigating = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
        if (details?.isMainFrame === false || details?.isSameDocument) return
        detach(entry)
      }
      const destroyed = () => {
        detach(entry)
        windows.delete(id)
        contents.off('did-finish-load', loaded)
        contents.off('render-process-gone', gone)
        contents.off('did-start-navigation', navigating as never)
      }
      contents.on('did-finish-load', loaded)
      contents.on('render-process-gone', gone)
      contents.on('did-start-navigation', navigating as never)
      contents.on('destroyed', destroyed)
      broker(id)
    },
    attached: () => [...windows.values()].flatMap((entry) => (entry.clientId ? [entry.clientId] : [])),
  }
}

/** The window id main put in the document's query, as main reads it back for the workspace bus. */
export function windowIdFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get('windowId')?.trim() || null
  } catch {
    return null
  }
}
