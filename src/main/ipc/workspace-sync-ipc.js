import { BrowserWindow } from 'electron';
export function registerWorkspaceSyncIpc(ipcMain, service, options = {}) {
    const getSourceWindowId = options.getSourceWindowId ?? defaultSourceWindowId;
    const listWindows = options.listWindows ?? (() => BrowserWindow.getAllWindows());
    // Events minted with no source window to skip — a gateway create, an
    // automation, the scheduler, a phone — reach every window through this
    // subscription. A window-originated dispatch deliberately does NOT announce
    // here; the handler below broadcasts it so the sending window is skipped.
    service.subscribeEvents((syncEvent) => {
        broadcastWorkspaceSyncEvent(syncEvent, null, listWindows());
    });
    ipcMain.handle('workspace-sync:dispatch', (event, command) => {
        const result = service.dispatch({ command, sourceWindowId: getSourceWindowId(event) });
        if (result.ok)
            broadcastWorkspaceSyncEvent(result.event, event.sender, listWindows());
        return result;
    });
    ipcMain.handle('workspace-sync:get-snapshot', () => service.getSnapshot());
    ipcMain.handle('workspace-sync:get-events-after', (_event, sequence) => service.getEventsAfter(sequence));
    // One-time hydration from a window's post-migrate-ladder localStorage state
    // (MC-2158). The window offers; main seeds only when it has never written a
    // registry, so a second window racing the first is a no-op rather than a
    // merge. Answering `needsHydration: false` is how a window learns to stop
    // offering and start mirroring.
    ipcMain.handle('workspace-registry:needs-hydration', () => options.registry?.needsHydration() ?? false);
    ipcMain.handle('workspace-registry:hydrate', (_event, payload) => {
        if (!options.registry)
            return { changed: false, reason: 'already_present' };
        return options.registry.hydrate(payload ?? {});
    });
}
function broadcastWorkspaceSyncEvent(syncEvent, source, windows) {
    for (const window of windows) {
        if (window.isDestroyed() || window.webContents.isDestroyed())
            continue;
        if (source && window.webContents.id === source.id)
            continue;
        window.webContents.send('workspace-sync:event', syncEvent);
    }
}
function defaultSourceWindowId(event) {
    return workspaceWindowIdFromUrl(event.sender.getURL());
}
function workspaceWindowIdFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.searchParams.get('windowId')?.trim() || 'primary';
    }
    catch {
        return 'primary';
    }
}
