import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { WorkspaceSyncEvent } from '../../shared/workspace-sync'
import type { WorkspaceSyncService } from '../workspace-sync-service'
import type { WorkspaceRegistryHydratePayload, WorkspaceRegistryService } from '../workspace-registry-service'

type BroadcastTarget = {
  isDestroyed(): boolean
  webContents: WebContents
}

type RegisterWorkspaceSyncIpcOptions = {
  listWindows?: () => BroadcastTarget[]
  getSourceWindowId?: (event: IpcMainInvokeEvent) => string
  /**
   * The registry behind the bus, for the one-time localStorage hydration
   * channel. Omitted in tests that only exercise the bus.
   */
  registry?: WorkspaceRegistryService
}

export function registerWorkspaceSyncIpc(
  ipcMain: IpcMain,
  service: WorkspaceSyncService,
  options: RegisterWorkspaceSyncIpcOptions = {}
): void {
  const getSourceWindowId = options.getSourceWindowId ?? defaultSourceWindowId
  const listWindows = options.listWindows ?? (() => BrowserWindow.getAllWindows())

  // Events minted with no source window to skip — a gateway create, an
  // automation, the scheduler, a phone — reach every window through this
  // subscription. A window-originated dispatch deliberately does NOT announce
  // here; the handler below broadcasts it so the sending window is skipped.
  service.subscribeEvents((syncEvent) => {
    broadcastWorkspaceSyncEvent(syncEvent, null, listWindows())
  })

  ipcMain.handle('workspace-sync:dispatch', (event, command: unknown) => {
    const result = service.dispatch({ command, sourceWindowId: getSourceWindowId(event) })
    if (result.ok) broadcastWorkspaceSyncEvent(result.event, event.sender, listWindows())
    return result
  })

  ipcMain.handle('workspace-sync:get-snapshot', () => service.getSnapshot())
  ipcMain.handle('workspace-sync:get-events-after', (_event, sequence: unknown) => service.getEventsAfter(sequence))

  // One-time hydration from a window's post-migrate-ladder localStorage state
  // (MC-2158). The window offers; main seeds only when it has never written a
  // registry, so a second window racing the first is a no-op rather than a
  // merge. Answering `needsHydration: false` is how a window learns to stop
  // offering and start mirroring.
  ipcMain.handle('workspace-registry:needs-hydration', () => options.registry?.needsHydration() ?? false)
  ipcMain.handle('workspace-registry:hydrate', (_event, payload: WorkspaceRegistryHydratePayload) => {
    if (!options.registry) return { changed: false, reason: 'already_present' }
    return options.registry.hydrate(payload ?? {})
  })
}

function broadcastWorkspaceSyncEvent(
  syncEvent: WorkspaceSyncEvent,
  source: WebContents | null,
  windows: BroadcastTarget[]
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if (source && window.webContents.id === source.id) continue
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
