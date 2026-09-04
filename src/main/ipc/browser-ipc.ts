import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BrowserRegisterInput } from '../../shared/browser'
import type { BrowserManager } from '../browser/browser-manager'

// The embedded browser's IPC (browser-pane epic). Every handler resolves the
// tab by id through the manager, which refuses ids it never adopted; the
// registering call binds the guest to the window that sent it.

function tabIdOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const tabId = (input as { tabId?: unknown }).tabId
  return typeof tabId === 'string' && tabId.length > 0 ? tabId : null
}

export function registerBrowserIpc(ipcMain: IpcMain, manager: BrowserManager): void {
  ipcMain.handle('browser:config', () => manager.getConfig())

  ipcMain.handle('browser:register', (event: IpcMainInvokeEvent, input: BrowserRegisterInput) => {
    if (
      !input
      || typeof input.tabId !== 'string'
      || typeof input.workspaceId !== 'string'
      || typeof input.webContentsId !== 'number'
    ) {
      return { ok: false, reason: 'unknown_webcontents' }
    }
    return manager.register(input, event.sender)
  })

  ipcMain.handle('browser:unregister', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    if (tabId) manager.unregister(tabId)
  })

  ipcMain.handle('browser:state', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.state(tabId) : null
  })

  ipcMain.handle('browser:navigate', (_event, input: { tabId: string; url: string }) => {
    const tabId = tabIdOf(input)
    if (!tabId || typeof input.url !== 'string') return false
    return manager.navigate(tabId, input.url)
  })

  ipcMain.handle('browser:back', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.back(tabId) : false
  })

  ipcMain.handle('browser:forward', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.forward(tabId) : false
  })

  ipcMain.handle('browser:reload', (_event, input: { tabId: string; ignoreCache?: boolean }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.reload(tabId, input.ignoreCache === true) : false
  })

  ipcMain.handle('browser:stop', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.stop(tabId) : false
  })

  ipcMain.handle('browser:open-external', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.openExternal(tabId) : { ok: false, message: 'This browser tab is gone.' }
  })

  ipcMain.handle('browser:local-servers', (_event, input: { workspaceId: string }) => {
    const workspaceId = input && typeof input.workspaceId === 'string' ? input.workspaceId : ''
    return workspaceId ? manager.listLocalServers(workspaceId) : []
  })
}
