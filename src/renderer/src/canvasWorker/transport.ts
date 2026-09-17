// The wire to main, and the only thing in this directory that knows about IPC.
//
// Three rules, and the handshake main's host is written against:
//
//   1. The worker subscribes and says `canvasWorkerReady(report)` exactly once,
//      after the fonts are in. Main waits for that before it sends anything; a
//      request arriving earlier would be measured in the wrong face. The report
//      is how main learns a face never arrived at all — the one degradation
//      that is otherwise invisible, because measurements taken in a fallback
//      face are written into the person's file and simply look wrong.
//   2. Requests are served strictly one at a time. The editor package holds
//      module-level caches — shape geometry, character widths — and two
//      conversions interleaved through an await would read each other's.
//   3. Every request is answered exactly once, whatever happens, including a
//      throw from the handler. Main correlates on `requestId` and drops a reply
//      that arrives after its deadline, so a late answer is wasted but harmless;
//      a missing one costs the caller the full deadline.

import type {
  CanvasWorkerReport,
  CanvasWorkerRequest,
  CanvasWorkerResponse,
} from '../../../shared/canvas/worker-protocol'
import { isRecord } from '../../../shared/records'

export type CanvasWorkerHandler = (request: CanvasWorkerRequest) => Promise<CanvasWorkerResponse>

export type CanvasWorkerTransport = { attached: boolean; detach: () => void }

/**
 * Subscribe, then announce readiness.
 *
 * Returns without attaching when there is no preload — which is how this page
 * is opened in a plain browser to be driven through `window.__canvasWorker`.
 */
export function startCanvasWorkerTransport(
  handle: CanvasWorkerHandler,
  report: CanvasWorkerReport,
): CanvasWorkerTransport {
  const api = typeof window === 'undefined' ? undefined : window.api
  if (!api || typeof api.onCanvasWorkerRequest !== 'function' || typeof api.canvasWorkerReady !== 'function') {
    return { attached: false, detach: () => {} }
  }

  // One promise chain is the queue: each request is appended to it and runs when
  // the one before it has answered.
  let queue: Promise<void> = Promise.resolve()

  const unsubscribe = api.onCanvasWorkerRequest((request) => {
    queue = queue.then(() => serve(handle, api.canvasWorkerRespond, request))
  })

  api.canvasWorkerReady(report)
  return { attached: true, detach: unsubscribe }
}

async function serve(
  handle: CanvasWorkerHandler,
  respond: (response: CanvasWorkerResponse) => void,
  request: CanvasWorkerRequest,
): Promise<void> {
  const requestId = isRecord(request) && typeof request.requestId === 'string' ? request.requestId : ''
  let response: CanvasWorkerResponse
  try {
    response = await handle(request)
  } catch (error) {
    response = {
      requestId,
      ok: false,
      error: { code: 'worker_unavailable', message: error instanceof Error ? error.message : String(error) },
    }
  }
  try {
    respond(response)
  } catch (error) {
    // The channel is gone — main has closed the window, or is reloading it.
    // There is nobody left to tell, so this is the end of the line.
    console.error('[canvas-worker] the response could not be sent', error)
  }
}
