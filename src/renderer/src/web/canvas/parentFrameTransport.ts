import type {
  CanvasWorkerReport,
  CanvasWorkerRequest,
  CanvasWorkerResponse,
} from '../../../../shared/canvas/worker-protocol'
import { CANVAS_FRAME_CHANNEL, readFrameMessage } from './frameProtocol'

// The worker document's end of the wire when it runs as a web tab's hidden
// frame (frameProtocol.ts): the same handshake and queue the desktop's IPC
// transport keeps (canvasWorker/transport.ts), over `postMessage` to the
// parent page. Only a frame of the parent's own origin uses it.

/** Whether this document is a frame of a page of its own origin, the only parent it would serve. */
export function hasSameOriginParent(view: Window = window): boolean {
  if (view.parent === view) return false
  try {
    return view.parent.location.origin === view.location.origin
  } catch {
    return false
  }
}

export function startParentFrameTransport(
  serve: (request: CanvasWorkerRequest, respond: (response: CanvasWorkerResponse) => void) => Promise<void>,
  report: CanvasWorkerReport,
  view: Window = window,
): () => void {
  const parent = view.parent
  const origin = view.location.origin
  let queue: Promise<void> = Promise.resolve()
  const respond = (response: CanvasWorkerResponse) =>
    parent.postMessage({ channel: CANVAS_FRAME_CHANNEL, type: 'response', response }, origin)
  const onMessage = (event: MessageEvent) => {
    const message = readFrameMessage(event, { source: parent, origin })
    if (message?.type !== 'request') return
    queue = queue.then(() => serve(message.request, respond))
  }
  view.addEventListener('message', onMessage)
  parent.postMessage({ channel: CANVAS_FRAME_CHANNEL, type: 'ready', report }, origin)
  return () => view.removeEventListener('message', onMessage)
}
