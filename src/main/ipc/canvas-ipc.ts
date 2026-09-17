import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import type { CanvasBoardRef, CanvasElement, CanvasResult } from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import { normalizeCanvasPath } from '../../shared/canvas/paths'
import { isRecord } from '../../shared/records'
import type { CanvasServiceInternal } from '../canvas/canvas-service'
import type { CanvasSubscriberRegistry } from '../canvas/canvas-subscribers'

// The Canvas pane's IPC. Five channels, and every one of them treats its
// payload as input rather than as the shape the preload promises — the preload
// is ours, but the renderer it runs in hosts a lazy-loaded editor and
// third-party module code, and the service behind this writes files into the
// person's project. A caller that spells a path badly gets `invalid_path`; one
// that sends half a megabyte of nothing gets `too_large`; neither reaches disk.

/** A scene past this is not a drawing anyone is working on. */
const MAX_COMMIT_ELEMENTS = 20_000
/** And past this the drawing itself is not one that should cross an IPC boundary. */
const MAX_COMMIT_ELEMENT_BYTES = 25 * 1024 * 1024
/** One embedded image. Past this it is a photograph somebody dropped on a diagram. */
const MAX_COMMIT_FILE_BYTES = 15 * 1024 * 1024
/** The whole commit: the drawing and everything embedded in it, together. */
const MAX_COMMIT_TOTAL_BYTES = 40 * 1024 * 1024

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

function refOf(input: unknown): CanvasResult<CanvasBoardRef> {
  if (!isRecord(input)) return canvasFail('invalid_path', 'This call carried no board.')
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (!workspaceId) return canvasFail('no_workspace', 'This call named no workspace.')
  if (typeof input.path !== 'string') return canvasFail('invalid_path', 'A board path must be a string.')
  const path = normalizeCanvasPath(input.path)
  if (!path.ok) return path
  return canvasOk({ workspaceId, path: path.value })
}

/**
 * The elements a commit carries, checked for shape and for size.
 *
 * Only the four fields the merge acts on are required; everything else on an
 * element is the editor's and rides along untouched (see `CanvasElement`). The
 * serialized size is measured once, here, because the service's next step is
 * writing it into the project.
 */
function elementsOf(input: unknown): CanvasResult<{ elements: CanvasElement[]; bytes: number }> {
  if (!Array.isArray(input)) return canvasFail('invalid_scene', 'A commit must carry an array of elements.')
  if (input.length > MAX_COMMIT_ELEMENTS) {
    return canvasFail(
      'too_large',
      `A board may hold at most ${MAX_COMMIT_ELEMENTS} elements; this one has ${input.length}.`,
    )
  }
  const elements: CanvasElement[] = []
  for (const candidate of input) {
    if (!isRecord(candidate)) return canvasFail('invalid_scene', 'Every element must be an object.')
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      return canvasFail('invalid_scene', 'Every element must carry an id.')
    }
    if (typeof candidate.type !== 'string') return canvasFail('invalid_scene', 'Every element must carry a type.')
    if (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version)) {
      return canvasFail('invalid_scene', `Element ${candidate.id} has no version to merge on.`)
    }
    if (typeof candidate.versionNonce !== 'number' || !Number.isFinite(candidate.versionNonce)) {
      return canvasFail('invalid_scene', `Element ${candidate.id} has no versionNonce to merge on.`)
    }
    elements.push(candidate as CanvasElement)
  }
  let size = 0
  try {
    size = JSON.stringify(elements).length
  } catch {
    // Circular, or something with a throwing toJSON: it could not be written
    // to the project either.
    return canvasFail('invalid_scene', 'This scene could not be serialized.')
  }
  if (size > MAX_COMMIT_ELEMENT_BYTES) {
    return canvasFail(
      'too_large',
      `The drawing itself is ${megabytes(size)}, over the ${megabytes(MAX_COMMIT_ELEMENT_BYTES)} a board may hold. Split it across two boards.`,
    )
  }
  return canvasOk({ elements, bytes: size })
}

/**
 * The blobs a commit carries: every image pasted onto the board, base64 and all.
 *
 * Measured and capped like the elements, and for the same reason — this is the
 * step before a write into somebody's project, and the file the merge produces
 * is add-only, so an image that arrives once is in the board for good. Per file
 * as well as in total, because the total alone would let one enormous image
 * through on an otherwise empty board.
 */
function filesOf(input: unknown): CanvasResult<{ files: Record<string, unknown>; bytes: number }> {
  if (!isRecord(input)) return canvasOk({ files: {}, bytes: 0 })
  let total = 0
  for (const [id, value] of Object.entries(input)) {
    let size: number
    try {
      size = JSON.stringify(value)?.length ?? 0
    } catch {
      return canvasFail('invalid_scene', `The embedded file ${id} could not be serialized.`)
    }
    if (size > MAX_COMMIT_FILE_BYTES) {
      return canvasFail(
        'too_large',
        `The embedded file ${id} is ${megabytes(size)}, over the ${megabytes(MAX_COMMIT_FILE_BYTES)} one image may be. Remove it, or bring in a smaller copy.`,
      )
    }
    total += size
  }
  if (total > MAX_COMMIT_TOTAL_BYTES) {
    return canvasFail(
      'too_large',
      `The images on this board come to ${megabytes(total)}, over the ${megabytes(MAX_COMMIT_TOTAL_BYTES)} a board may hold. Remove some of them.`,
    )
  }
  return canvasOk({ files: input, bytes: total })
}

function recordOf(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

export function registerCanvasIpc(
  ipcMain: IpcMain,
  service: CanvasServiceInternal,
  subscribers: CanvasSubscriberRegistry,
): void {
  // A window that closed, reloaded or crashed stops being a subscriber of every
  // board it held, without each board having to notice separately.
  subscribers.onGone((subscriberId) => service.dropSubscriber(subscriberId))

  ipcMain.handle('canvas:list-boards', (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      return canvasFail('no_workspace', 'This call named no workspace.')
    }
    return service.listBoards(workspaceId.trim())
  })

  ipcMain.handle('canvas:open-board', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = refOf(input)
    if (!ref.ok) return ref
    const create = isRecord(input) && input.create === true
    // Opening is what subscribes: the window that asked for the board is the
    // one that gets pushed every accepted write to it until it closes it.
    const subscriberId = subscribers.add(event.sender)
    return service.openBoard(ref.value, { create, subscriberId })
  })

  ipcMain.handle('canvas:close-board', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = refOf(input)
    if (!ref.ok) return
    service.closeBoard(ref.value, event.sender.id)
  })

  ipcMain.handle('canvas:commit-scene', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = refOf(input)
    if (!ref.ok) return ref
    const record = input as Record<string, unknown>
    const elements = elementsOf(record.elements)
    if (!elements.ok) return elements
    const files = filesOf(record.files)
    if (!files.ok) return files
    const total = elements.value.bytes + files.value.bytes
    if (total > MAX_COMMIT_TOTAL_BYTES) {
      return canvasFail(
        'too_large',
        `This board comes to ${megabytes(total)} with its images, over the ${megabytes(MAX_COMMIT_TOTAL_BYTES)} one board may hold. Split it, or remove an embedded image.`,
      )
    }
    const baseRevision =
      typeof record.baseRevision === 'number' && Number.isFinite(record.baseRevision) ? record.baseRevision : 0
    // The sender is registered here too: a commit from a window that has not
    // opened the board still has to be excluded from its own echo.
    const subscriberId = subscribers.add(event.sender)
    return service.commitScene(
      {
        ...ref.value,
        baseRevision,
        elements: elements.value.elements,
        appState: recordOf(record.appState),
        files: files.value.files,
      },
      subscriberId,
    )
  })

  // Fire-and-forget by contract: the person has started a gesture, and an
  // answer would only be read after the gesture was over.
  ipcMain.on('canvas:note-human-input', (event: IpcMainEvent, input: unknown) => {
    const ref = refOf(input)
    if (!ref.ok) return
    service.noteHumanInput(ref.value, event.sender.id)
  })
}
