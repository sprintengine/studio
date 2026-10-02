// How server code tells every attached client that something changed.
//
// In the desktop a client is a window, and `publish` is the
// `BrowserWindow.getAllWindows()` loop that services used to write themselves:
// the topic is the push channel the preload subscribes to. On a standalone
// server a client is a protocol connection, and the same topic becomes a
// stream its subscribers hear. Nothing is buffered either way: a client that
// attaches later reads the current state, then hears what changes after.

/**
 * Which clients a push is for: every one, the workspace windows (not
 * Diagnostics or an aux view), one window, or every window but the one that
 * caused it (a window that made a change already shows it).
 */
export type ClientTarget = 'all' | 'workspace-windows' | { clientId: string } | { exceptClientId: string }

export type ClientBus = {
  /** Deliver `payload` on `topic` to the targeted clients (all by default), best effort per client. */
  publish(topic: string, payload: unknown, target?: ClientTarget): void
}

export type ClientBusListener = (topic: string, payload: unknown, target: ClientTarget) => void

/** The bus outside Electron: in-process listeners, which the protocol's streams subscribe through. */
export type LocalClientBus = ClientBus & {
  subscribe(listener: ClientBusListener): () => void
}

export function createLocalClientBus(): LocalClientBus {
  const listeners = new Set<ClientBusListener>()
  return {
    publish(topic, payload, target = 'all') {
      for (const listener of [...listeners]) {
        try {
          listener(topic, payload, target)
        } catch {
          // One subscriber's failure is not another's, as one window's is not.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
