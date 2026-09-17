// The wire between the service in main and the hidden canvas worker window.
//
// Four of these five operations need a DOM: turning a skeleton into real
// geometry, repairing bindings, importing a diagram from text, and rendering an
// image are all the editor package's own work, and it only runs in a renderer.
// So main owns the file and the merge, and hands anything that needs a document
// to a window nobody sees. That window is a renderer like any other, which is
// why this contract is here in shared rather than in either half.
//
// Every request carries a `requestId` and every response echoes it: the host
// correlates on that alone, so a slow worker answering after its deadline is
// dropped rather than mistaken for the reply to a newer request.

import type {
  CanvasEditRequest,
  CanvasEditResult,
  CanvasElement,
  CanvasError,
  CanvasImage,
  CanvasLayoutRequest,
} from './types'

/**
 * What the worker says about itself when it comes up.
 *
 * The scene fonts are woff2 files the editor fetches for itself, and the worker
 * answers after a deadline whether or not they arrived — a worker measuring
 * text in a fallback face writes those measurements into the person's file. So
 * the readiness handshake carries the outcome rather than being a bare signal,
 * and every write made while a family is missing says so.
 */
export type CanvasWorkerReport = {
  /** Families the document confirms it can render, by CSS name. */
  loaded: string[]
  /** Families still missing when the deadline passed. */
  missing: string[]
  /** Anything that went wrong badly enough to be worth saying out loud. */
  errors: string[]
}

export type CanvasWorkerRequest =
  | {
      kind: 'apply-edit'
      requestId: string
      elements: CanvasElement[]
      files: Record<string, unknown>
      edit: CanvasEditRequest
    }
  | {
      kind: 'layout'
      requestId: string
      elements: CanvasElement[]
      request: CanvasLayoutRequest
    }
  | {
      kind: 'import-mermaid'
      requestId: string
      definition: string
      /** Where to place the imported diagram; the board's empty space, usually. */
      origin?: { x: number; y: number }
    }
  | {
      kind: 'import-scene'
      requestId: string
      /** Another scene file's parsed contents, of unknown provenance and shape. */
      scene: unknown
    }
  | {
      kind: 'export-image'
      requestId: string
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
      /** A subset to frame the shot on. Absent means the whole board. */
      elementIds?: string[]
      maxEdge: number
      background: boolean
      dark: boolean
      format: 'png' | 'jpeg'
      /** JPEG only, 0–1. */
      quality?: number
    }

export type CanvasWorkerSuccess =
  | {
      kind: 'apply-edit'
      requestId: string
      ok: true
      /** The FULL next element array, versions bumped and bindings repaired. */
      elements: CanvasElement[]
      /**
       * EVERY id whose version this request moved, including ones the edit did
       * not name: the shape that gained a `boundElements` entry when an arrow
       * was fastened to it, the label a retext tombstoned, the arrow re-routed
       * because the box it points at moved.
       *
       * `result.updated` is the agent's own list — what it asked to change —
       * and stays that. This is what the service tests for a collision, and the
       * two are not the same set: the person dragging a shape the edit merely
       * repaired is exactly the case a nonce tie-break decides by coin toss.
       */
      changed: string[]
      files: Record<string, unknown>
      result: CanvasEditResult
    }
  | {
      kind: 'layout'
      requestId: string
      ok: true
      elements: CanvasElement[]
      /** As for `apply-edit`: every id whose version moved. */
      changed: string[]
      /** What could not be arranged, in the words the tool passes on. */
      warnings?: string[]
    }
  /** New elements only — the service merges them into the board itself. */
  | { kind: 'import-mermaid'; requestId: string; ok: true; elements: CanvasElement[]; files: Record<string, unknown> }
  /** The imported scene, restored and normalised to this format. */
  | { kind: 'import-scene'; requestId: string; ok: true; elements: CanvasElement[]; files: Record<string, unknown> }
  | { kind: 'export-image'; requestId: string; ok: true; image: CanvasImage }

export type CanvasWorkerFailure = { requestId: string; ok: false; error: CanvasError }

export type CanvasWorkerResponse = CanvasWorkerSuccess | CanvasWorkerFailure

export type CanvasWorkerRequestKind = CanvasWorkerRequest['kind']

/** The request of one kind, for a handler that switches on `kind`. */
export type CanvasWorkerRequestOf<K extends CanvasWorkerRequestKind> = Extract<CanvasWorkerRequest, { kind: K }>

/** What a caller of one kind may get back: that kind's success, or a failure. */
export type CanvasWorkerResponseOf<K extends CanvasWorkerRequestKind> =
  | Extract<CanvasWorkerSuccess, { kind: K }>
  | CanvasWorkerFailure

export function isCanvasWorkerFailure(response: CanvasWorkerResponse): response is CanvasWorkerFailure {
  return response.ok === false
}
