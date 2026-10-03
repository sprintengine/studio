import type { Duplex } from 'node:stream'

import type { SshRoutedConnection, SshRoutedServers } from '../core/routed-conversation-backend'
import { portDuplex } from '../ipc/port-duplex'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { connectRemoteConversationBackend } from '../wsl/backend-wire'
import type { FrontDoorPurpose } from '../wsl/front-door-proof'

// SSH machines for the desktop's server when it runs as a process of its own
// (phase 8 with phase 6). Main holds the SSH sessions (their prompts are its
// dialogs); for each stream the server needs (the conversation wire, the
// shell-role connection its toolsets are relayed over), it asks main, which
// opens the stream on the machine's relay and hands the server a message
// port spliced onto it. So a chat on an SSH machine is routed here exactly as
// it is in process.

export type ShellSshServersDeps = {
  /** Ask main for a stream on the machine's relay; its port arrives on the control channel as `clientId`. */
  open(key: string, purpose: FrontDoorPurpose): Promise<{ clientId: string; label: string }>
  /** The port main attached for `clientId`, once it has arrived. */
  takePort(clientId: string): TunnelPort | null
  log?(message: string): void
}

export type ShellSshServers = {
  servers: SshRoutedServers
  onConnected(listener: (connection: SshRoutedConnection & { open(purpose: 'studio'): Promise<Duplex> }) => void): void
  /** Main says a machine connected (or reconnected): follow its chats. */
  machineConnected(key: string): void
}

const PORT_WAIT_MS = 5_000

export function createShellSshServers(deps: ShellSshServersDeps): ShellSshServers {
  const current = new Map<string, SshRoutedConnection & { open(purpose: 'studio'): Promise<Duplex> }>()
  const pending = new Map<string, Promise<SshRoutedConnection>>()
  const listeners: Array<(connection: SshRoutedConnection & { open(purpose: 'studio'): Promise<Duplex> }) => void> = []

  async function stream(key: string, purpose: FrontDoorPurpose): Promise<{ stream: Duplex; label: string }> {
    const { clientId, label } = await deps.open(key, purpose)
    const deadline = Date.now() + PORT_WAIT_MS
    let port = deps.takePort(clientId)
    while (!port && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      port = deps.takePort(clientId)
    }
    if (!port) throw new Error(`The connection to ${label} did not arrive from the app.`)
    return { stream: portDuplex(port), label }
  }

  async function connectNow(key: string): Promise<SshRoutedConnection> {
    const { stream: wire, label } = await stream(key, 'backend')
    const backend = connectRemoteConversationBackend(wire, { ...(deps.log ? { log: deps.log } : {}) })
    await backend.refresh()
    const connection = {
      key,
      label,
      backend,
      open: async (purpose: 'studio') => (await stream(key, purpose)).stream,
    }
    current.set(key, connection)
    backend.onClose(() => {
      if (current.get(key) === connection) current.delete(key)
    })
    for (const listener of listeners) {
      try {
        listener(connection)
      } catch (error) {
        deps.log?.(`An SSH connection listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return connection
  }

  const servers: SshRoutedServers = {
    connect(key) {
      const live = current.get(key)
      if (live && live.backend.isOpen()) return Promise.resolve(live)
      let running = pending.get(key)
      if (!running) {
        running = connectNow(key).finally(() => pending.delete(key))
        pending.set(key, running)
      }
      return running
    },
    current: (key) => {
      const live = current.get(key)
      return live && live.backend.isOpen() ? live : null
    },
    touch: () => undefined,
  }

  return {
    servers,
    onConnected: (listener) => void listeners.push(listener),
    machineConnected(key) {
      const live = current.get(key)
      if (live?.backend.isOpen()) return
      void servers
        .connect(key)
        .catch((error: unknown) =>
          deps.log?.(`Could not follow ${key}'s chats: ${error instanceof Error ? error.message : String(error)}`),
        )
    },
  }
}
