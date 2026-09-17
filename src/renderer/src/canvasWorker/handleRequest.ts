// One request in, exactly one response out.
//
// Main correlates on `requestId` alone and gives up after a deadline, so the
// only unacceptable outcome here is silence: every path, including a throw from
// inside the editor package, ends in a response carrying that id. The switch is
// exhaustive and an unknown kind is answered rather than ignored, because a
// worker running an older bundle than main is a thing that happens after an
// update and "nothing came back" is the worst way to find out.

import type { CanvasElement } from '../../../shared/canvas/types'
import type { CanvasWorkerRequest, CanvasWorkerResponse } from '../../../shared/canvas/worker-protocol'
import { isRecord } from '../../../shared/records'
import { applyEdit } from './applyEdit'
import type { CanvasEditorBridge } from './editorBridge'
import { CanvasWorkerError, toCanvasError } from './errors'
import { applyLayout } from './layout'

export function createRequestHandler(bridge: CanvasEditorBridge) {
  return async function handleRequest(request: CanvasWorkerRequest): Promise<CanvasWorkerResponse> {
    const requestId = isRecord(request) && typeof request.requestId === 'string' ? request.requestId : ''
    try {
      return await dispatch(bridge, request, requestId)
    } catch (error) {
      return { requestId, ok: false, error: toCanvasError(error, 'invalid_edit') }
    }
  }
}

async function dispatch(
  bridge: CanvasEditorBridge,
  request: CanvasWorkerRequest,
  requestId: string,
): Promise<CanvasWorkerResponse> {
  switch (request.kind) {
    case 'apply-edit': {
      const outcome = applyEdit(bridge, request)
      return {
        kind: 'apply-edit',
        requestId,
        ok: true,
        elements: outcome.elements,
        changed: outcome.changed,
        files: outcome.files,
        result: outcome.result,
      }
    }
    case 'layout': {
      const outcome = applyLayout(bridge, request)
      return {
        kind: 'layout',
        requestId,
        ok: true,
        elements: outcome.elements,
        changed: outcome.changed,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      }
    }
    case 'import-mermaid': {
      const parsed = await bridge.parseMermaid(request.definition ?? '')
      const elements = bridge.convertFresh(parsed.elements)
      return {
        kind: 'import-mermaid',
        requestId,
        ok: true,
        elements: placeAt(elements, request.origin),
        files: parsed.files,
      }
    }
    case 'import-scene': {
      const restored = bridge.restoreScene(request.scene)
      return { kind: 'import-scene', requestId, ok: true, elements: restored.elements, files: restored.files }
    }
    case 'export-image': {
      const image = await bridge.exportImage({
        elements: framedElements(request.elements ?? [], request.elementIds),
        files: request.files ?? {},
        appState: request.appState ?? {},
        maxEdge: request.maxEdge,
        background: request.background,
        dark: request.dark,
        format: request.format,
        quality: request.quality,
      })
      return { kind: 'export-image', requestId, ok: true, image }
    }
    default: {
      const kind = isRecord(request) ? String((request as { kind?: unknown }).kind) : 'nothing'
      throw new CanvasWorkerError('invalid_edit', `This worker does not know the request kind "${kind}".`)
    }
  }
}

/**
 * Move an imported diagram so its top-left corner lands on `origin`.
 *
 * Where a diagram goes is the caller's decision — it knows what else is on the
 * board — so the default is the origin of the coordinate space and nothing
 * cleverer.
 */
function placeAt(elements: CanvasElement[], origin: { x: number; y: number } | undefined): CanvasElement[] {
  if (elements.length === 0) return elements
  let minX = Infinity
  let minY = Infinity
  for (const element of elements) {
    minX = Math.min(minX, num(element.x))
    minY = Math.min(minY, num(element.y))
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return elements
  const dx = num(origin?.x) - minX
  const dy = num(origin?.y) - minY
  if (dx === 0 && dy === 0) return elements
  // Only the origin moves: a linear element's points and a label's offset are
  // both relative to it, so translating them as well would double the shift.
  return elements.map((element) => ({ ...element, x: num(element.x) + dx, y: num(element.y) + dy }))
}

/**
 * The elements a shot is framed on.
 *
 * A named selection brings its labels with it — a box whose text was left
 * behind is not what anybody meant by "screenshot this box" — and nothing else,
 * because an arrow to a shape outside the frame would stretch the shot to cover
 * the shape it points at.
 */
function framedElements(elements: CanvasElement[], elementIds: string[] | undefined): CanvasElement[] {
  const live = elements.filter((element) => element.isDeleted !== true)
  if (!elementIds || elementIds.length === 0) return live
  const wanted = new Set(elementIds)
  const out = live.filter(
    (element) =>
      wanted.has(element.id) ||
      (typeof element.containerId === 'string' && wanted.has(element.containerId)),
  )
  if (out.length === 0) {
    throw new CanvasWorkerError('invalid_scene', 'None of those elements are on this board.')
  }
  return out
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
