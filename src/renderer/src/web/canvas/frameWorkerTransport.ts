import type { CanvasWorkerTransport } from '../../../../main/canvas/canvas-worker-host'
import type { CanvasWorkerReport, CanvasWorkerResponse } from '../../../../shared/canvas/worker-protocol'
import { CANVAS_FRAME_CHANNEL, readFrameMessage } from './frameProtocol'

// The page's end of the canvas worker in a web tab (phase 9 spec, 3.8): the
// worker document the desktop opens in a hidden window, loaded here in a
// hidden frame of the tab's own origin. It is the `CanvasWorkerTransport` the
// worker host drives, so the deadlines, the queue and the restart are the
// desktop's own (canvas-worker-host.ts); only the wire differs.
//
// The frame is laid out, off-screen and inert: an editor in a `display: none`
// subtree measures every glyph as zero.

const READY_TIMEOUT_MS = 30_000
const WORKER_DOCUMENT = 'canvas-worker.html'

export type FrameWorkerTransportOptions = {
  /** Where the frame goes; the document's body. */
  host?: () => HTMLElement
  /** The worker document's address; beside the app's page. */
  src?: () => string
  readyTimeoutMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
}

export function createFrameWorkerTransport(options: FrameWorkerTransportOptions = {}): CanvasWorkerTransport {
  const host = options.host ?? (() => document.body)
  const src = options.src ?? (() => new URL(WORKER_DOCUMENT, window.location.href).toString())
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const responseListeners = new Set<(response: CanvasWorkerResponse) => void>()
  const crashListeners = new Set<(reason: string) => void>()
  let frame: HTMLIFrameElement | null = null
  let ready: Promise<void> | null = null
  let report: CanvasWorkerReport | null = null
  let stopListening: (() => void) | null = null

  function teardown(): void {
    stopListening?.()
    stopListening = null
    frame?.remove()
    frame = null
    ready = null
    report = null
  }

  function crashed(reason: string): void {
    options.log?.('The canvas worker frame went away', { reason })
    teardown()
    for (const listener of [...crashListeners]) listener(reason)
  }

  function create(): Promise<void> {
    const element = document.createElement('iframe')
    element.title = 'Canvas worker'
    element.setAttribute('aria-hidden', 'true')
    element.tabIndex = -1
    // Laid out at a fixed, non-zero size, and parked where nobody sees it.
    Object.assign(element.style, {
      position: 'fixed',
      left: '-10000px',
      top: '-10000px',
      width: '800px',
      height: '600px',
      border: '0',
      pointerEvents: 'none',
      visibility: 'hidden',
    })
    frame = element
    const handshake = new Promise<void>((settle, reject) => {
      const timer = setTimeout(() => reject(new Error('The canvas worker did not report ready.')), readyTimeoutMs)
      const onMessage = (event: MessageEvent) => {
        const message = readFrameMessage(event, { source: element.contentWindow, origin: window.location.origin })
        if (!message) return
        if (message.type === 'ready') {
          clearTimeout(timer)
          report = message.report
          settle()
        } else if (message.type === 'response') {
          for (const listener of [...responseListeners]) listener(message.response)
        }
      }
      window.addEventListener('message', onMessage)
      stopListening = () => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
      }
      // A frame that loads again after it said it was ready lost its worker
      // (it navigated or was reloaded): that is a crash, which the host restarts.
      let loads = 0
      element.addEventListener('load', () => {
        loads += 1
        if (loads > 1 && frame === element && report) crashed('the worker document loaded again')
      })
      element.addEventListener('error', () => {
        clearTimeout(timer)
        if (report && frame === element) crashed('the worker document failed')
        else reject(new Error('The canvas worker document did not load.'))
      })
    })
    element.src = src()
    host().append(element)
    return handshake
  }

  return {
    ensureStarted() {
      if (frame && ready) return ready
      const started = create().catch((error: unknown) => {
        teardown()
        throw error
      })
      ready = started
      return started
    },
    post(request) {
      const target = frame?.contentWindow
      if (!target) throw new Error('The canvas worker frame is gone.')
      target.postMessage({ channel: CANVAS_FRAME_CHANNEL, type: 'request', request }, window.location.origin)
    },
    onResponse(cb) {
      responseListeners.add(cb)
      return () => responseListeners.delete(cb)
    },
    onCrashed(cb) {
      crashListeners.add(cb)
      return () => crashListeners.delete(cb)
    },
    report: () => report,
    // Asked to stop (idle, disposal): not a crash, so nobody restarts it.
    stop() {
      teardown()
    },
  }
}
