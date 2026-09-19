import { app, BrowserWindow } from 'electron'

export function getAllBrowserWindows(): BrowserWindow[] {
  return typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []
}

export function getDesktopDisplayName(): string {
  return typeof app?.name === 'string' && app.name.trim() ? app.name : 'SprintEngine Desktop'
}
