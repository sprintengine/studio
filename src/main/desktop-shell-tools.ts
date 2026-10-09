import { connect, type StudioClient } from '../../packages/agent-sdk/src/client'
import type { StudioTransportFactory } from '../../packages/agent-sdk/src/transport'
import type { OfferedToolset } from '../../packages/agent-sdk/src/tools'
import type { McpToolRegistration } from '../shared/modules/mcp-tools'
import { offerGatewayTools } from './automation/offer-gateway-tools'

// The desktop's shell as a client of its own server: it offers the toolsets
// only a screen can serve (the browser pane, and the canvas from phase 5's
// second move) through the same `@sprintengine/agent-sdk` any app uses, over
// a port main holds both ends of, which is what makes it the shell. The
// handlers still run here in main, against the pane and the canvas worker;
// only the way a call reaches them changes.
//
// It also tells the server which workspaces this desktop shows and whether
// the person is looking at it, so a call is routed to the window in front of
// them when more than one desktop offers the same toolset.

export type DesktopShellToolset = {
  name: string
  registrations: McpToolRegistration[]
  /**
   * Whether the toolset is offered now; absent, always. Read as the client
   * connects and again on `refreshToolsets`, which offers or withdraws it to
   * match: a person turning the agents' browser off in Settings.
   */
  enabled?: () => boolean
}

export type DesktopFocus = { focused: boolean; workspaceIds: string[]; activeWorkspaceId?: string }

export type DesktopShellTools = {
  /**
   * Connect and offer. Resolves once every toolset is offered. A first
   * connect that fails is tried again, with backoff, until it succeeds or the
   * client is stopped: out of process the server may still be starting, or
   * restarting. Once connected, the SDK reconnects and offers everything again
   * by itself whenever the server comes back.
   */
  start(): Promise<void>
  stop(): void
  /** Offer what has been switched on and withdraw what has been switched off since. */
  refreshToolsets(): Promise<void>
  /** The client, once connected: for tests and diagnostics. */
  client(): StudioClient | null
}

const FOCUS_DEBOUNCE_MS = 500
const FIRST_CONNECT_RETRY_MS = { initial: 250, max: 10_000 }

export function createDesktopShellTools(options: {
  transport: StudioTransportFactory
  version?: string
  toolsets: DesktopShellToolset[]
  /** Where the person's attention is now, and a way to hear when it moves. */
  focus?: { current(): DesktopFocus; onChange(listener: () => void): () => void }
  log?: (message: string) => void
  /** How a failed first connect is tried again (tests shorten it). */
  retry?: { initialMs?: number; maxMs?: number }
}): DesktopShellTools {
  let client: StudioClient | null = null
  let starting: Promise<void> | null = null
  let stopped = false
  let unwatch: (() => void) | null = null
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  // What is offered now, by name. The SDK offers each again by itself after a
  // reconnect; one withdrawn here stays withdrawn until it is switched back on.
  const offered = new Map<string, OfferedToolset>()

  async function offerToolset(connected: StudioClient, toolset: DesktopShellToolset): Promise<void> {
    try {
      offered.set(toolset.name, await offerGatewayTools(connected, toolset.name, toolset.registrations))
    } catch (error) {
      options.log?.(
        `The desktop could not offer its ${toolset.name} tools: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // One pass at a time: a switch flipped while the first offers are still out
  // must not offer the same toolset twice.
  let syncing: Promise<void> = Promise.resolve()
  function syncToolsets(connected: StudioClient): Promise<void> {
    syncing = syncing.then(() => syncPass(connected))
    return syncing
  }

  async function syncPass(connected: StudioClient): Promise<void> {
    for (const toolset of options.toolsets) {
      const wanted = toolset.enabled?.() ?? true
      const current = offered.get(toolset.name)
      if (wanted && !current) await offerToolset(connected, toolset)
      else if (!wanted && current) {
        offered.delete(toolset.name)
        await current.withdraw().catch((error: unknown) => {
          options.log?.(
            `The desktop could not withdraw its ${toolset.name} tools: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
    }
  }

  function sendFocus(): void {
    focusTimer = null
    if (!client || !options.focus) return
    try {
      client.tools.focus(options.focus.current())
    } catch (error) {
      options.log?.(`The desktop's focus hint was not sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function run(): Promise<void> {
    const connected = await connect({
      transport: options.transport,
      client: {
        name: 'SprintEngine Studio',
        kind: 'desktop',
        ...(options.version ? { version: options.version } : {}),
      },
      // The port is in this process: nothing to ping, and a drop is a server
      // restart, which is worth retrying quickly.
      heartbeat: false,
      reconnect: { initialDelayMs: 50, maxDelayMs: 2_000 },
      onStateChange: (state, error) => {
        if (state === 'closed' && error && !stopped)
          options.log?.(`The desktop's tools client closed: ${error.code}: ${error.message}`)
      },
    })
    if (stopped) {
      connected.close()
      return
    }
    client = connected
    await syncToolsets(connected)
    if (options.focus) {
      sendFocus()
      unwatch = options.focus.onChange(() => {
        if (focusTimer) clearTimeout(focusTimer)
        focusTimer = setTimeout(sendFocus, FOCUS_DEBOUNCE_MS)
        focusTimer.unref?.()
      })
    }
  }

  async function runUntilConnected(): Promise<void> {
    let delay = options.retry?.initialMs ?? FIRST_CONNECT_RETRY_MS.initial
    const maxDelay = options.retry?.maxMs ?? FIRST_CONNECT_RETRY_MS.max
    let reported = false
    while (!stopped) {
      try {
        await run()
        return
      } catch (error) {
        // Said once: a server still starting is expected, not news each time.
        if (!reported)
          options.log?.(
            `The desktop's tools client did not connect yet, and keeps trying: ${error instanceof Error ? error.message : String(error)}`,
          )
        reported = true
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        timer.unref?.()
      })
      delay = Math.min(delay * 2, maxDelay)
    }
  }

  return {
    start() {
      starting ??= runUntilConnected()
      return starting
    },
    stop() {
      stopped = true
      unwatch?.()
      unwatch = null
      if (focusTimer) clearTimeout(focusTimer)
      focusTimer = null
      client?.close()
      client = null
    },
    async refreshToolsets() {
      if (client && !stopped) await syncToolsets(client)
    },
    client: () => client,
  }
}
