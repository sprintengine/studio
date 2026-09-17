// The editor package, behind one interface.
//
// Everything in this directory that is arithmetic — the skeleton translation,
// the arrow routing, the arranging operations, the version bookkeeping — is
// pure and tested in plain Node. Everything that needs the package (and, with
// it, a document, a canvas and loaded fonts) comes through here, so the two
// halves stay separable and the tests never reach for a DOM.

import type { CanvasElement, CanvasImage } from '../../../shared/canvas/types'
import type { LibrarySkeleton } from './skeletonMap'

export type ExportImageRequest = {
  elements: CanvasElement[]
  files: Record<string, unknown>
  appState: Record<string, unknown>
  maxEdge: number
  background: boolean
  dark: boolean
  format: 'png' | 'jpeg'
  quality?: number
}

export type CanvasEditorBridge = {
  /** Skeletons to real elements, keeping the ids they were given. */
  convert: (skeletons: LibrarySkeleton[]) => CanvasElement[]
  /** The same, minting fresh ids — for a diagram arriving from outside. */
  convertFresh: (skeletons: LibrarySkeleton[]) => CanvasElement[]
  /** An id in the file format's own alphabet. */
  newId: () => string
  /** A fresh `versionNonce`. */
  nonce: () => number
  /** Epoch milliseconds, for `updated`. */
  now: () => number
  /** Normalise a scene of unknown provenance and repair its bindings. */
  restoreScene: (scene: unknown) => { elements: CanvasElement[]; files: Record<string, unknown> }
  /** Render a scene to an image. */
  exportImage: (request: ExportImageRequest) => Promise<CanvasImage>
  /** Parse a diagram definition. Loads the importer on first use. */
  parseMermaid: (definition: string) => Promise<{ elements: LibrarySkeleton[]; files: Record<string, unknown> }>
}
