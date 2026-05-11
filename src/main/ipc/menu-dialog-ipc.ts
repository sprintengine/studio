import { BrowserWindow, Menu, dialog, type IpcMain } from 'electron'
import type { ContextMenuItem } from '../../shared/electron-api'

export function registerMenuDialogIpc(ipcMain: IpcMain): void {
  ipcMain.handle('fs:dialog:opendir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Open Folder',
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('fs:dialog:savefile', async (event, options: Electron.SaveDialogOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win!, options ?? {})
    return result.filePath ?? null
  })

  ipcMain.handle('fs:dialog:openfile', async (event, options: Electron.OpenDialogOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      ...(options ?? {}),
      properties: ['openFile'],
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('app:show-context-menu', async (event, items: ContextMenuItem[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    return await new Promise<string | null>((resolve) => {
      let settled = false
      const settle = (id: string | null) => {
        if (settled) return
        settled = true
        resolve(id)
      }

      const buildTemplate = (entries: ContextMenuItem[]): Electron.MenuItemConstructorOptions[] =>
        entries.map((item) => {
          if (item.type === 'separator') return { type: 'separator' }
          if (item.submenu && item.submenu.length > 0) {
            return {
              label: item.label ?? '',
              enabled: item.enabled ?? true,
              submenu: buildTemplate(item.submenu),
            }
          }
          return {
            label: item.label ?? '',
            enabled: item.enabled ?? true,
            type: item.type === 'checkbox' ? 'checkbox' : 'normal',
            checked: item.checked,
            click: () => settle(item.id ?? null),
          }
        })

      const menu = Menu.buildFromTemplate(buildTemplate(items))

      menu.popup({
        window: win,
        callback: () => settle(null),
      })
    })
  })

  ipcMain.handle('app:show-menubar-menu', async (
    event,
    menuLabel: string,
    position?: { x?: number; y?: number }
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const appMenu = Menu.getApplicationMenu()
    if (!win || !appMenu) return false

    const topLevelItem = appMenu.items.find((item) => item.label === menuLabel)
    if (!topLevelItem?.submenu) return false

    topLevelItem.submenu.popup({
      window: win,
      x: typeof position?.x === 'number' ? Math.round(position.x) : undefined,
      y: typeof position?.y === 'number' ? Math.round(position.y) : undefined,
    })

    return true
  })
}
