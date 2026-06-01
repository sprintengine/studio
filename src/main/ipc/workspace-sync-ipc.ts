import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { WorkspaceSyncEvent } from '../../shared/workspace-sync'
import type { WorkspaceSyncService } from '../workspace-sync-service'

type BroadcastTarget = {
  isDestroyed(): boolean
  webContents: WebContents
}

type RegisterWorkspaceSyncIpcOptions = {
  listWindows?: () => BroadcastTarget[]
  getSourceWindowId?: (event: IpcMainInvokeEvent) => string
}

export function registerWorkspaceSyncIpc(
  ipcMain: IpcMain,
  service: WorkspaceSyncService,
  options: RegisterWorkspaceSyncIpcOptions = {}
): void {
  const getSourceWindowId = options.getSourceWindowId ?? defaultSourceWindowId
  const listWindows = options.listWindows ?? (() => BrowserWindow.getAllWindows())

  ipcMain.handle('workspace-sync:dispatch', (event, command: unknown) => {
    const result = service.dispatch({
      command,
      sourceWindowId: getSourceWindowId(event),
    })
    if (result.ok) broadcastWorkspaceSyncEvent(result.event, event.sender, listWindows())
    return result
  })

  ipcMain.handle('workspace-sync:get-snapshot', () => service.getSnapshot())
  ipcMain.handle('workspace-sync:get-events-after', (_event, sequence: unknown) => service.getEventsAfter(sequence))
}

function broadcastWorkspaceSyncEvent(
  syncEvent: WorkspaceSyncEvent,
  source: WebContents,
  windows: BroadcastTarget[]
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if (window.webContents.id === source.id) continue
    window.webContents.send('workspace-sync:event', syncEvent)
  }
}

function defaultSourceWindowId(event: IpcMainInvokeEvent): string {
  return workspaceWindowIdFromUrl(event.sender.getURL())
}

function workspaceWindowIdFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}
