import { app, BrowserWindow } from 'electron';
export function getAllBrowserWindows() {
    return typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : [];
}
export function getDesktopDisplayName() {
    return typeof app?.name === 'string' && app.name.trim() ? app.name : 'Multicode Desktop';
}
