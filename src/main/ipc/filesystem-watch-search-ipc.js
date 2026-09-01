import { BrowserWindow } from 'electron';
import { watch } from 'fs';
const FILE_WATCH_EVENT_COALESCE_MS = 100;
export function registerFilesystemWatchSearchIpc(ipcMain, deps) {
    const fileWatchers = new Map();
    const trackedWatcherSenders = new Set();
    let nextFileWatcherId = 0;
    const disposeFileWatcher = (watchId) => {
        const fileWatcher = fileWatchers.get(watchId);
        if (!fileWatcher)
            return;
        if (fileWatcher.flushTimer) {
            clearTimeout(fileWatcher.flushTimer);
        }
        fileWatcher.watcher.close();
        fileWatchers.delete(watchId);
    };
    const disposeFileWatchersForSender = (senderId) => {
        for (const [watchId, fileWatcher] of fileWatchers.entries()) {
            if (fileWatcher.senderId === senderId) {
                if (fileWatcher.flushTimer) {
                    clearTimeout(fileWatcher.flushTimer);
                }
                fileWatcher.watcher.close();
                fileWatchers.delete(watchId);
            }
        }
    };
    const flushFileWatchEvent = (watchId) => {
        const fileWatcher = fileWatchers.get(watchId);
        if (!fileWatcher)
            return;
        fileWatcher.flushTimer = null;
        const watchEvent = fileWatcher.pendingEvent;
        fileWatcher.pendingEvent = null;
        if (!watchEvent)
            return;
        const sender = BrowserWindow.getAllWindows()
            .map((window) => window.webContents)
            .find((webContents) => webContents.id === fileWatcher.senderId);
        if (!sender || sender.isDestroyed())
            return;
        sender.send(`fs:watch-event:${watchId}`, watchEvent);
    };
    const scheduleFileWatchEvent = (watchId, watchEvent) => {
        const fileWatcher = fileWatchers.get(watchId);
        if (!fileWatcher)
            return;
        fileWatcher.pendingEvent = fileWatcher.pendingEvent
            ? { eventType: 'change', path: null }
            : watchEvent;
        if (fileWatcher.flushTimer)
            clearTimeout(fileWatcher.flushTimer);
        fileWatcher.flushTimer = setTimeout(() => flushFileWatchEvent(watchId), FILE_WATCH_EVENT_COALESCE_MS);
    };
    ipcMain.handle('fs:watch-start', async (event, dirPath) => {
        if (!trackedWatcherSenders.has(event.sender.id)) {
            trackedWatcherSenders.add(event.sender.id);
            event.sender.once('destroyed', () => {
                trackedWatcherSenders.delete(event.sender.id);
                disposeFileWatchersForSender(event.sender.id);
            });
        }
        if (!(await deps.pathExists(dirPath)))
            return null;
        const watchId = `watch-${++nextFileWatcherId}`;
        const recursive = process.platform === 'win32' || process.platform === 'darwin';
        const createWatcher = (useRecursive) => watch(dirPath, { recursive: useRecursive }, (eventType, filename) => {
            if (event.sender.isDestroyed())
                return;
            scheduleFileWatchEvent(watchId, {
                eventType,
                path: typeof filename === 'string' ? filename : null,
            });
        });
        try {
            const watcher = createWatcher(recursive);
            fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null });
            return watchId;
        }
        catch (error) {
            if (deps.isMissingPathError(error))
                return null;
            if (!recursive) {
                throw error;
            }
            try {
                const watcher = createWatcher(false);
                fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null });
                return watchId;
            }
            catch (fallbackError) {
                if (deps.isMissingPathError(fallbackError))
                    return null;
                throw fallbackError;
            }
        }
    });
    ipcMain.handle('fs:watch-stop', (_, watchId) => {
        disposeFileWatcher(watchId);
    });
    ipcMain.handle('fs:search-files', async (event, input) => {
        return deps.searchFiles(event.sender.id, input);
    });
    ipcMain.handle('fs:search-content', async (event, input) => {
        return deps.searchContent(event.sender.id, input);
    });
    ipcMain.handle('fs:cancel-content-search', (event) => {
        deps.cancelActiveContentSearch(event.sender.id);
    });
}
