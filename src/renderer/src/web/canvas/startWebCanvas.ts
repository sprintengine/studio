import { connect } from '../../../../../packages/agent-sdk/src/index'
import { windowPortTransport } from '../../studio/windowStudioClient'
import { isWindowVisible, onWindowVisibilityChange } from '../../utils/windowActivity'
import { webPageUrl } from '../webLocation'
import { createWebStudioPorts } from '../webStudioPorts'
import { createFrameWorkerTransport } from './frameWorkerTransport'
import { createWebCanvasTools } from './webCanvasTools'
import { startWebCanvasToolset } from './webCanvasToolset'
import { provideWebCanvasService, webCanvasPaneBus } from './webCanvasPane'

// A web tab's `canvas` toolset, started once the app has loaded (phase 9
// spec, 3.8). It has a Studio connection of its own, which says it is a web
// client: the server reads the kind only from an owner's grant, and lets a
// web client offer `canvas` and nothing else of the built-in toolsets.

async function ownerSession(): Promise<boolean> {
  const response = await fetch(webPageUrl('api/session'), { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) return false
  const body = (await response.json()) as { session?: { owner?: unknown } }
  return body.session?.owner === true
}

export function startWebCanvas(): void {
  const reconnected = new Set<() => void>()
  let opened = false
  void startWebCanvasToolset({
    isOwnerSession: ownerSession,
    connect: () =>
      connect({
        transport: windowPortTransport(createWebStudioPorts()),
        client: { name: 'Studio web', kind: 'web' },
        reconnect: { initialDelayMs: 250, maxDelayMs: 10_000 },
        // Back after a drop: every watched board folder is read once more.
        onStateChange: (state) => {
          if (state !== 'open') return
          if (opened) for (const listener of [...reconnected]) listener()
          opened = true
        },
      }),
    tools: (client) => {
      const tools = createWebCanvasTools(client, {
        worker: createFrameWorkerTransport({ log: (message) => console.warn('[canvas]', message) }),
        onReconnect: (listener) => {
          reconnected.add(listener)
          return () => reconnected.delete(listener)
        },
        pane: webCanvasPaneBus,
      })
      // The tab's Canvas pane draws boards through the same service.
      provideWebCanvasService(tools.service)
      return tools
    },
    view: window,
    visible: () => isWindowVisible(),
    onVisibilityChange: (listener) => onWindowVisibilityChange(listener),
    log: (message) => console.warn('[canvas]', message),
  })
    // A tab that runs no service tells its pane so, rather than leaving it waiting.
    .then(() => provideWebCanvasService(null))
    .catch((error: unknown) => {
      provideWebCanvasService(null)
      console.warn('[canvas] the toolset did not start', error)
    })
}
