import type { SshPaneTraffic } from '../../../shared/ssh-environments'
import { isLoopbackTarget, SshPaneForward } from './pane-forward'
import type { SshServerConnection } from './ssh-environment'

// Which browser partition a workspace's pane tabs use, and the forward behind
// an SSH machine's (phase 8 spec, 6.8; decisions R75, R76).
//
// A workspace on this computer keeps today's one partition. A workspace on an
// SSH machine gets that machine's own, `persist:env-<environment id>`, shared
// by its workspaces, with its proxy set to the machine's forward and
// `<-loopback>`, so `localhost` in those tabs is the machine's. Its cookies
// and storage stay on this computer, in that partition, apart from local
// tabs'. The forward is opened by the machine's first tab and closed a moment
// after its last, so the port exists only while a tab needs it.

/** What Chromium says about a request before it is sent: the slice of Electron's details the guard reads. */
export type PaneRequest = { url: string; method: string; resourceType: string; initiatorOrigin?: string }

/** The slice of an Electron session this needs. */
export type ProxySession = {
  setProxy(config: { proxyRules: string; proxyBypassRules: string }): Promise<void>
  clearStorageData(options?: { storages?: string[] }): Promise<void>
  webRequest?: {
    onBeforeRequest(listener: (details: PaneRequest, callback: (response: { cancel: boolean }) => void) => void): void
  }
}

/** Whether an origin is a page served from loopback (`http://localhost:5173`), whose own calls to loopback are its own. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackTarget(url.hostname)
  } catch {
    return false
  }
}

/**
 * Whether a request in a machine's partition is a site on the internet
 * reaching that machine's loopback (phase 8 spec, V-P3): a subresource, a
 * frame, a WebSocket or a form post to `localhost` (or `127.x`, `[::1]`,
 * `0.0.0.0`) whose initiator is a web origin that is not itself loopback, or
 * an opaque one (a sandboxed frame such a site made). Chromium's own
 * private-network checks do not see through the proxy, and a machine's
 * loopback holds what an agent runs there: dev servers, databases' web
 * consoles, debug ports. A local browser keeps public sites from the
 * laptop's loopback the same way.
 *
 * Allowed: anything with no initiator (the person typing a URL, an agent's
 * `browser.open`, the browser's own requests), anything a loopback page asks
 * for, the developer tools' own fetches (`devtools://`), and a top-level GET
 * navigation, which a link to a dev server is.
 */
export function blocksForeignLoopback(request: PaneRequest): boolean {
  let target: URL
  try {
    target = new URL(request.url)
  } catch {
    return false
  }
  if (!isLoopbackTarget(target.hostname)) return false
  const initiator = request.initiatorOrigin
  if (!initiator) return false
  if (initiator !== 'null') {
    if (isLoopbackOrigin(initiator)) return false
    if (!/^(?:https?|wss?):/u.test(initiator)) return false
  }
  if (request.resourceType === 'mainFrame' && request.method === 'GET') return false
  return true
}

export type PanePartitionDeps = {
  /** The SSH machine a workspace is on, by its saved id, or null for this computer's. */
  machineOf(workspaceId: string): { id: string; label: string } | null
  /** A saved machine's server environment id, once reached; its partition is named for it. */
  environmentIdOf(id: string): string | null
  traffic(id: string): SshPaneTraffic
  current(id: string): SshServerConnection | null
  /** Bring the machine up in the background (no prompt); resolves true once it is. */
  connect(id: string, ms: number): Promise<boolean>
  sessionFor(partition: string): ProxySession
  closeDelayMs?: number
  log?(message: string): void
}

type Forwarded = {
  id: string
  partition: string
  forward: SshPaneForward
  /** Resolves once the session's proxy points at the forward. */
  ready: Promise<void>
  tabs: Set<string>
  closeTimer: ReturnType<typeof setTimeout> | null
}

const SAFE = /[^A-Za-z0-9_-]/gu

/** A machine's partition name: by its server's environment id, else by its saved id until one is known. */
export function environmentPartition(savedId: string, environmentId: string | null): string {
  return environmentId
    ? `persist:env-${environmentId.replace(SAFE, '')}`
    : `persist:env-ssh-${savedId.replace(SAFE, '')}`
}

export class PanePartitions {
  private readonly byMachine = new Map<string, Forwarded>()
  private readonly tabPartition = new Map<string, string>()
  private readonly prepared = new Set<string>()

  constructor(private readonly deps: PanePartitionDeps) {}

  /**
   * The partition for a workspace's new tab: null for this computer's own, or
   * the machine's, its forward open and its proxy set before this returns.
   * A machine whose browser traffic is off uses this computer's partition.
   */
  async forWorkspace(workspaceId: string): Promise<{ partition: string; label: string } | null> {
    const machine = this.deps.machineOf(workspaceId)
    if (!machine || this.deps.traffic(machine.id) === 'off') return null
    let entry = this.byMachine.get(machine.id)
    if (!entry) {
      const partition = environmentPartition(machine.id, this.deps.environmentIdOf(machine.id))
      const forward = new SshPaneForward({
        label: machine.label,
        openRemote: async (host, port) => {
          const connection = this.deps.current(machine.id)
          if (!connection)
            throw Object.assign(new Error(`${machine.label} is reconnecting. This tab's network goes through it.`), {
              code: 'reconnecting',
            })
          return connection.openTcp(host, port)
        },
        connected: () => this.deps.current(machine.id) !== null,
        waitConnected: (ms) => this.deps.connect(machine.id, ms),
        traffic: () => this.deps.traffic(machine.id),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      })
      const created: Forwarded = {
        id: machine.id,
        partition,
        forward,
        tabs: new Set(),
        closeTimer: null,
        ready: forward.open().then(async (port) => {
          const session = this.deps.sessionFor(partition)
          // Before any guest loads: a site in these tabs never reaches the
          // machine's loopback behind the person's back (V-P3).
          session.webRequest?.onBeforeRequest((details, callback) =>
            callback({ cancel: blocksForeignLoopback(details) }),
          )
          await session.setProxy({
            // An HTTP proxy for every scheme; WebSockets are tunnelled by CONNECT.
            proxyRules: `127.0.0.1:${port}`,
            // Chromium never proxies loopback unless told to: this removes that
            // rule, so the machine's localhost is the one these tabs reach.
            proxyBypassRules: '<-loopback>',
          })
        }),
      }
      this.byMachine.set(machine.id, created)
      entry = created
    }
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer)
      entry.closeTimer = null
    }
    try {
      await entry.ready
    } catch (error) {
      this.byMachine.delete(machine.id)
      throw error
    }
    this.prepared.add(entry.partition)
    // Opened for a tab that never comes: let it go after the delay too.
    this.scheduleClose(entry)
    return { partition: entry.partition, label: machine.label }
  }

  /** Whether a guest may attach to this partition: one this module set a proxy on. */
  isPrepared(partition: string): boolean {
    return this.prepared.has(partition)
  }

  /** Every partition this module has set a proxy on. */
  preparedPartitions(): string[] {
    return [...this.prepared]
  }

  /** Whether a partition is an SSH machine's, for a tab's `network` and its WebRTC policy. */
  isMachinePartition(partition: string): boolean {
    return [...this.byMachine.values()].some((entry) => entry.partition === partition) || this.prepared.has(partition)
  }

  tabOpened(partition: string, tabId: string): void {
    const entry = [...this.byMachine.values()].find((candidate) => candidate.partition === partition)
    if (!entry) return
    entry.tabs.add(tabId)
    this.tabPartition.set(tabId, partition)
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer)
      entry.closeTimer = null
    }
  }

  tabClosed(tabId: string): void {
    const partition = this.tabPartition.get(tabId)
    if (!partition) return
    this.tabPartition.delete(tabId)
    const entry = [...this.byMachine.values()].find((candidate) => candidate.partition === partition)
    if (!entry) return
    entry.tabs.delete(tabId)
    this.scheduleClose(entry)
  }

  private scheduleClose(entry: Forwarded): void {
    if (entry.tabs.size > 0 || entry.closeTimer) return
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null
      if (entry.tabs.size > 0) return
      this.byMachine.delete(entry.id)
      // No guest attaches to it again until a new forward is open and the
      // session points at that one: its proxy names a port now free for
      // anything on this computer to take.
      this.prepared.delete(entry.partition)
      void entry.forward.close()
    }, this.deps.closeDelayMs ?? 5_000)
    entry.closeTimer.unref?.()
  }

  /**
   * Chromium asks for the proxy's credential: given only for a machine's own
   * forward, on its own port, to a request from that machine's partition.
   */
  answerLogin(
    partition: string | null,
    authInfo: { isProxy: boolean; host: string; port: number },
  ): { username: string; password: string } | null {
    if (!authInfo.isProxy || !partition) return null
    for (const entry of this.byMachine.values()) {
      if (entry.partition !== partition) continue
      if (!entry.forward.answers(authInfo.host, authInfo.port)) return null
      return { username: entry.forward.username, password: entry.forward.password }
    }
    return null
  }

  /** Forget a machine: its forward closes, and its browsing data goes when asked. */
  async forget(id: string, options: { clearBrowsingData: boolean; environmentId: string | null }): Promise<void> {
    const entry = this.byMachine.get(id)
    this.byMachine.delete(id)
    if (entry) this.prepared.delete(entry.partition)
    if (entry?.closeTimer) clearTimeout(entry.closeTimer)
    await entry?.forward.close()
    if (options.clearBrowsingData)
      await this.deps.sessionFor(environmentPartition(id, options.environmentId)).clearStorageData()
  }

  async shutdown(): Promise<void> {
    for (const entry of this.byMachine.values()) {
      if (entry.closeTimer) clearTimeout(entry.closeTimer)
      await entry.forward.close()
    }
    this.byMachine.clear()
  }
}
