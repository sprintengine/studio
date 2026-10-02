import { connect, type StudioClient } from '../../packages/agent-sdk/src/client'
import type { StudioTransportFactory } from '../../packages/agent-sdk/src/transport'
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

export type DesktopShellToolset = { name: string; registrations: McpToolRegistration[] }

export type DesktopFocus = { focused: boolean; workspaceIds: string[]; activeWorkspaceId?: string }

export type DesktopShellTools = {
  /** Connect and offer. Resolves once every toolset is offered, or the first try failed (it keeps trying). */
  start(): Promise<void>
  stop(): void
  /** The client, once connected: for tests and diagnostics. */
  client(): StudioClient | null
}

const FOCUS_DEBOUNCE_MS = 500

export function createDesktopShellTools(options: {
  transport: StudioTransportFactory
  version?: string
  toolsets: DesktopShellToolset[]
  /** Where the person's attention is now, and a way to hear when it moves. */
  focus?: { current(): DesktopFocus; onChange(listener: () => void): () => void }
  log?: (message: string) => void
}): DesktopShellTools {
  let client: StudioClient | null = null
  let starting: Promise<void> | null = null
  let stopped = false
  let unwatch: (() => void) | null = null
  let focusTimer: ReturnType<typeof setTimeout> | null = null

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
    for (const toolset of options.toolsets) {
      try {
        await offerGatewayTools(connected, toolset.name, toolset.registrations)
      } catch (error) {
        options.log?.(
          `The desktop could not offer its ${toolset.name} tools: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (options.focus) {
      sendFocus()
      unwatch = options.focus.onChange(() => {
        if (focusTimer) clearTimeout(focusTimer)
        focusTimer = setTimeout(sendFocus, FOCUS_DEBOUNCE_MS)
        focusTimer.unref?.()
      })
    }
  }

  return {
    start() {
      starting ??= run().catch((error: unknown) => {
        options.log?.(
          `The desktop's tools client did not connect: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
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
    client: () => client,
  }
}
