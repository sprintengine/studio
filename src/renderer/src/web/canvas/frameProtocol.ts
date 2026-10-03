import type {
  CanvasWorkerReport,
  CanvasWorkerRequest,
  CanvasWorkerResponse,
} from '../../../../shared/canvas/worker-protocol'
import { isRecord } from '../../../../shared/records'

// The canvas worker's wire inside a web tab (phase 9 spec, 3.8). On the
// desktop the worker document talks to main over IPC; in a browser it is a
// hidden frame of the tab's own origin, and the two talk by `postMessage`.
// Each end accepts a message only from the other's window and only from its
// own origin, and reads it as input: a shape it does not expect is dropped.

export const CANVAS_FRAME_CHANNEL = 'sprintengine-canvas-worker'

export type CanvasFrameMessage =
  | { channel: typeof CANVAS_FRAME_CHANNEL; type: 'ready'; report: CanvasWorkerReport }
  | { channel: typeof CANVAS_FRAME_CHANNEL; type: 'request'; request: CanvasWorkerRequest }
  | { channel: typeof CANVAS_FRAME_CHANNEL; type: 'response'; response: CanvasWorkerResponse }

/** The fonts report, read for the three lists it promises and nothing else. */
export function readReport(input: unknown): CanvasWorkerReport {
  const source = isRecord(input) ? input : {}
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, 32)
          .map((entry) => entry.slice(0, 200))
      : []
  return { loaded: strings(source.loaded), missing: strings(source.missing), errors: strings(source.errors) }
}

/** A message on this wire, from the expected window and this document's own origin; null for anything else. */
export function readFrameMessage(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  expected: { source: unknown; origin: string },
): CanvasFrameMessage | null {
  if (event.source !== expected.source || event.origin !== expected.origin) return null
  const data = event.data as unknown
  if (!isRecord(data) || data.channel !== CANVAS_FRAME_CHANNEL) return null
  if (data.type === 'ready') return { channel: CANVAS_FRAME_CHANNEL, type: 'ready', report: readReport(data.report) }
  if (data.type === 'request' && isRecord(data.request) && typeof data.request.requestId === 'string')
    return { channel: CANVAS_FRAME_CHANNEL, type: 'request', request: data.request as CanvasWorkerRequest }
  if (data.type === 'response' && isRecord(data.response) && typeof data.response.requestId === 'string')
    return { channel: CANVAS_FRAME_CHANNEL, type: 'response', response: data.response as CanvasWorkerResponse }
  return null
}
