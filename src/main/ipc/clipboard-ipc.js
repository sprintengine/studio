import { clipboard } from 'electron';
export function registerClipboardIpc(ipcMain) {
    ipcMain.handle('clipboard:read-text', () => clipboard.readText());
    ipcMain.handle('clipboard:write-text', (_event, text) => {
        if (typeof text !== 'string') {
            throw new TypeError('clipboard:write-text expects a string payload');
        }
        clipboard.writeText(text);
    });
}
