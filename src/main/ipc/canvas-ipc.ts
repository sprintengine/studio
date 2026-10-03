import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

import type { CanvasExportImages, CanvasExportResult, CanvasResult } from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import { canvasCommitOf, canvasRefOf } from '../../shared/canvas/commit-checks'
import { isRecord } from '../../shared/records'
import type { CanvasServiceInternal } from '../canvas/canvas-service'
import type { CanvasSubscriberRegistry } from '../canvas/canvas-subscribers'

// The Canvas pane's IPC. Seven channels, and every one of them treats its
// payload as input rather than as the shape the preload promises — the preload
// is ours, but the renderer it runs in hosts a lazy-loaded editor and
// third-party module code, and the service behind this writes files into the
// person's project. A caller that spells a path badly gets `invalid_path`; one
// that sends half a megabyte of nothing gets `too_large`; neither reaches disk.

// The checks themselves are in shared/canvas/commit-checks.ts, where a web
// tab's Canvas pane reaches them too.

/**
 * The images an export carries, checked for type only: their size and shape are
 * the service's to judge, and an absent or malformed field is simply not an
 * image the person asked for.
 */
function exportImagesOf(input: unknown): CanvasExportImages {
  if (!isRecord(input)) return {}
  return {
    ...(typeof input.png === 'string' && input.png.length > 0 ? { png: input.png } : {}),
    ...(typeof input.svg === 'string' && input.svg.length > 0 ? { svg: input.svg } : {}),
  }
}

export type CanvasIpcOptions = {
  /**
   * Show the folder picker for an export and answer the folder, or null when
   * the person dismissed it. Injected so the boundary can be tested without a
   * native dialog; absent, an export is refused rather than written anywhere.
   */
  pickExportDirectory?: (sender: WebContents, defaultPath?: string) => Promise<string | null>
  /** Show a board file in the system file manager; absent, reveal answers `forbidden`. */
  revealFile?: (absolutePath: string) => void
}

export function registerCanvasIpc(
  ipcMain: IpcMain,
  service: CanvasServiceInternal,
  subscribers: CanvasSubscriberRegistry,
  options: CanvasIpcOptions = {},
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
    const ref = canvasRefOf(input)
    if (!ref.ok) return ref
    const create = isRecord(input) && input.create === true
    // Opening is what subscribes: the window that asked for the board is the
    // one that gets pushed every accepted write to it until it closes it.
    const subscriberId = subscribers.add(event.sender)
    return service.openBoard(ref.value, { create, subscriberId })
  })

  ipcMain.handle('canvas:close-board', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return
    service.closeBoard(ref.value, event.sender.id)
  })

  ipcMain.handle('canvas:commit-scene', (event: IpcMainInvokeEvent, input: unknown) => {
    const commit = canvasCommitOf(input)
    if (!commit.ok) return commit
    // The sender is registered here too: a commit from a window that has not
    // opened the board still has to be excluded from its own echo.
    const subscriberId = subscribers.add(event.sender)
    return service.commitScene(commit.value, subscriberId)
  })

  // The folder comes from the picker main shows, never from the payload: the
  // renderer may suggest where the picker opens, and that is all it may say
  // about where the files land.
  ipcMain.handle(
    'canvas:export-board',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CanvasResult<CanvasExportResult>> => {
      const ref = canvasRefOf(input)
      if (!ref.ok) return ref
      if (!options.pickExportDirectory) {
        return canvasFail('forbidden', 'Exporting a board is not available in this window.')
      }
      const record = input as Record<string, unknown>
      const defaultPath = typeof record.defaultDirectory === 'string' ? record.defaultDirectory : undefined
      let directory: string | null
      try {
        directory = await options.pickExportDirectory(event.sender, defaultPath)
      } catch (error) {
        return canvasFail(
          'forbidden',
          `The folder picker could not be shown: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!directory) return canvasOk({ cancelled: true })
      const exported = await service.exportBoard(ref.value, directory, exportImagesOf(record.images))
      if (!exported.ok) return exported
      return canvasOk({ cancelled: false, directory: exported.value.directory, files: exported.value.files })
    },
  )

  // Main finds the file and shows it: a store board is in the app's data
  // folder, which the renderer cannot name, and only needs to name its board.
  ipcMain.handle('canvas:reveal-board', (_event: IpcMainInvokeEvent, input: unknown): CanvasResult<void> => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return ref
    if (!options.revealFile) return canvasFail('forbidden', 'Revealing a board is not available in this window.')
    const location = service.boardLocation(ref.value)
    if (!location.ok) return location
    options.revealFile(location.value)
    return canvasOk(undefined)
  })

  // Fire-and-forget by contract: the person has started a gesture, and an
  // answer would only be read after the gesture was over.
  ipcMain.on('canvas:note-human-input', (event: IpcMainEvent, input: unknown) => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return
    service.noteHumanInput(ref.value, event.sender.id)
  })
}
