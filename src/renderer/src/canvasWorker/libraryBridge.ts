// The editor package, actually called.
//
// This is the only file in the worker that imports `@excalidraw/excalidraw`,
// which is what lets everything else be tested without a browser. It is also
// where the package's habits are absorbed, and they are worth naming:
//
//  - `convertToExcalidrawElements` keeps the ids it is given when
//    `regenerateIds` is false, and rebuilds every element it is handed through
//    the constructor, which preserves id, seed, version and nonce and drops
//    nothing a generic element carries. That is what makes it safe to pass an
//    element that already exists through it just so an arrow can fasten to it.
//  - `exportToCanvas` ignores `appState.exportScale` whenever
//    `maxWidthOrHeight` is supplied, so the size is computed through
//    `getDimensions` instead — see exportSize.ts for the rule.
//  - The diagram importer is a large graph of its own and needs a document, so
//    it is fetched on the first import rather than with the page.

import { convertToExcalidrawElements, exportToBlob, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import type { CanvasElement, CanvasImage } from '../../../shared/canvas/types'
import { CANVAS_DEFAULT_BACKGROUND } from '../../../shared/canvas/scene-file'
import { isRecord } from '../../../shared/records'
import type { CanvasEditorBridge, ExportImageRequest } from './editorBridge'
import { CanvasWorkerError } from './errors'
import { exportDimensions } from './exportSize'
import type { LibrarySkeleton } from './skeletonMap'

/** The padding the export leaves around the board's own bounds. */
const EXPORT_PADDING = 16

/** The alphabet the file format's ids are drawn from. */
const ID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
const ID_LENGTH = 21

export function createLibraryBridge(): CanvasEditorBridge {
  return {
    convert: (skeletons) => runConvert(skeletons, false),
    convertFresh: (skeletons) => runConvert(skeletons, true),
    newId,
    nonce: () => Math.floor(random() * 2 ** 31),
    now: () => Date.now(),
    restoreScene,
    exportImage,
    parseMermaid,
  }
}

function runConvert(skeletons: LibrarySkeleton[], regenerateIds: boolean): CanvasElement[] {
  const converted = convertToExcalidrawElements(skeletons as unknown as ExcalidrawElementSkeleton[], {
    regenerateIds,
  })
  return converted as unknown as CanvasElement[]
}

function restoreScene(scene: unknown): { elements: CanvasElement[]; files: Record<string, unknown> } {
  const source = Array.isArray(scene) ? { elements: scene } : isRecord(scene) ? scene : null
  if (!source) {
    throw new CanvasWorkerError('invalid_scene', 'A scene must be an object or an array of elements.')
  }
  const elements = source.elements
  if (!Array.isArray(elements)) {
    throw new CanvasWorkerError('invalid_scene', 'A scene must carry an `elements` array.')
  }
  let restored: readonly ExcalidrawElement[]
  try {
    restored = restoreElements(elements as ExcalidrawElement[], null, {
      repairBindings: true,
      refreshDimensions: false,
    })
  } catch (error) {
    throw new CanvasWorkerError(
      'invalid_scene',
      `That scene could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return {
    elements: restored as unknown as CanvasElement[],
    files: isRecord(source.files) ? (source.files as Record<string, unknown>) : {},
  }
}

async function exportImage(request: ExportImageRequest): Promise<CanvasImage> {
  const elements = request.elements.filter((element) => element.isDeleted !== true)
  if (elements.length === 0) {
    throw new CanvasWorkerError('invalid_scene', 'There is nothing on this board to render.')
  }

  const background = isRecord(request.appState) ? request.appState.viewBackgroundColor : undefined
  const appState: Partial<AppState> = {
    exportBackground: request.background,
    viewBackgroundColor: typeof background === 'string' ? background : CANVAS_DEFAULT_BACKGROUND,
    exportWithDarkMode: request.dark,
    exportEmbedScene: false,
  }

  let width = 0
  let height = 0
  const mimeType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const blob = await exportToBlob({
    elements: elements as unknown as readonly NonDeleted<ExcalidrawElement>[],
    files: (request.files ?? {}) as BinaryFiles,
    appState,
    mimeType,
    quality: request.format === 'jpeg' ? request.quality : undefined,
    exportPadding: EXPORT_PADDING,
    getDimensions: (naturalWidth: number, naturalHeight: number) => {
      const size = exportDimensions(naturalWidth, naturalHeight, request.maxEdge)
      width = size.width
      height = size.height
      return size
    },
  })

  return { data: await toBase64(blob), mimeType, width, height }
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  // Chunked rather than one spread: a megabyte of pixels is more arguments than
  // `String.fromCharCode` will take in one call.
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < buffer.length; at += chunk) {
    binary += String.fromCharCode(...buffer.subarray(at, at + chunk))
  }
  return btoa(binary)
}

async function parseMermaid(
  definition: string,
): Promise<{ elements: LibrarySkeleton[]; files: Record<string, unknown> }> {
  let parse: typeof import('@excalidraw/mermaid-to-excalidraw').parseMermaidToExcalidraw
  try {
    ;({ parseMermaidToExcalidraw: parse } = await import('@excalidraw/mermaid-to-excalidraw'))
  } catch (error) {
    throw new CanvasWorkerError(
      'worker_unavailable',
      `The diagram importer could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    // The font size is the board's own default, so an imported diagram is set
    // in the same measure as everything drawn beside it.
    const result = await parse(definition, { themeVariables: { fontSize: '20px' } })
    return {
      elements: (result.elements ?? []) as unknown as LibrarySkeleton[],
      files: (result.files ?? {}) as Record<string, unknown>,
    }
  } catch (error) {
    throw new CanvasWorkerError(
      'invalid_edit',
      `That diagram definition could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function newId(): string {
  const bytes = new Uint8Array(ID_LENGTH)
  cryptoSource().getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length]
  return out
}

function random(): number {
  const bytes = new Uint32Array(1)
  cryptoSource().getRandomValues(bytes)
  return bytes[0] / 2 ** 32
}

function cryptoSource(): Crypto {
  return globalThis.crypto
}
