import { BrowserWindow, type IpcMain } from 'electron'
import { watch, type FSWatcher } from 'fs'
import type { ContentSearchResult, FileSearchResult, FileWatchEvent } from '../../shared/electron-api'

type FileSearchRequest = {
  rootPath: string
  query: string
  limit?: number
}

type ContentSearchRequest = FileSearchRequest

type FileWatcherRecord = {
  watcher: FSWatcher
  senderId: number
  pendingEvent: FileWatchEvent | null
  flushTimer: NodeJS.Timeout | null
}

type FilesystemWatchSearchIpcDependencies = {
  pathExists(targetPath: string): Promise<boolean>
  isMissingPathError(error: unknown): boolean
  searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult>
  searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult>
  cancelActiveContentSearch(senderId: number): void
}

const FILE_WATCH_EVENT_COALESCE_MS = 100

export function registerFilesystemWatchSearchIpc(ipcMain: IpcMain, deps: FilesystemWatchSearchIpcDependencies): void {
  const fileWatchers = new Map<string, FileWatcherRecord>()
  const trackedWatcherSenders = new Set<number>()
  let nextFileWatcherId = 0

  const disposeFileWatcher = (watchId: string): void => {
    const fileWatcher = fileWatchers.get(watchId)
    if (!fileWatcher) return

    if (fileWatcher.flushTimer) {
      clearTimeout(fileWatcher.flushTimer)
    }
    fileWatcher.watcher.close()
    fileWatchers.delete(watchId)
  }

  const disposeFileWatchersForSender = (senderId: number): void => {
    for (const [watchId, fileWatcher] of fileWatchers.entries()) {
      if (fileWatcher.senderId === senderId) {
        if (fileWatcher.flushTimer) {
          clearTimeout(fileWatcher.flushTimer)
        }
        fileWatcher.watcher.close()
        fileWatchers.delete(watchId)
      }
    }
  }

  const flushFileWatchEvent = (watchId: string): void => {
    const fileWatcher = fileWatchers.get(watchId)
    if (!fileWatcher) return

    fileWatcher.flushTimer = null
    const watchEvent = fileWatcher.pendingEvent
    fileWatcher.pendingEvent = null
    if (!watchEvent) return

    const sender = BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .find((webContents) => webContents.id === fileWatcher.senderId)
    if (!sender || sender.isDestroyed()) return

    sender.send(`fs:watch-event:${watchId}`, watchEvent)
  }

  const scheduleFileWatchEvent = (watchId: string, watchEvent: FileWatchEvent): void => {
    const fileWatcher = fileWatchers.get(watchId)
    if (!fileWatcher) return

    fileWatcher.pendingEvent = fileWatcher.pendingEvent ? { eventType: 'change', path: null } : watchEvent

    if (fileWatcher.flushTimer) clearTimeout(fileWatcher.flushTimer)
    fileWatcher.flushTimer = setTimeout(() => flushFileWatchEvent(watchId), FILE_WATCH_EVENT_COALESCE_MS)
  }

  ipcMain.handle('fs:watch-start', async (event, dirPath: string): Promise<string | null> => {
    if (!trackedWatcherSenders.has(event.sender.id)) {
      trackedWatcherSenders.add(event.sender.id)
      event.sender.once('destroyed', () => {
        trackedWatcherSenders.delete(event.sender.id)
        disposeFileWatchersForSender(event.sender.id)
      })
    }

    if (!(await deps.pathExists(dirPath))) return null

    const watchId = `watch-${++nextFileWatcherId}`
    const recursive = process.platform === 'win32' || process.platform === 'darwin'

    const createWatcher = (useRecursive: boolean): FSWatcher =>
      watch(dirPath, { recursive: useRecursive }, (eventType, filename) => {
        if (event.sender.isDestroyed()) return
        scheduleFileWatchEvent(watchId, {
          eventType,
          path: typeof filename === 'string' ? filename : null,
        })
      })

    try {
      const watcher = createWatcher(recursive)
      fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null })
      return watchId
    } catch (error) {
      if (deps.isMissingPathError(error)) return null
      if (!recursive) {
        throw error
      }

      try {
        const watcher = createWatcher(false)
        fileWatchers.set(watchId, { watcher, senderId: event.sender.id, pendingEvent: null, flushTimer: null })
        return watchId
      } catch (fallbackError) {
        if (deps.isMissingPathError(fallbackError)) return null
        throw fallbackError
      }
    }
  })

  ipcMain.handle('fs:watch-stop', (_, watchId: string): void => {
    disposeFileWatcher(watchId)
  })

  ipcMain.handle('fs:search-files', async (event, input: FileSearchRequest): Promise<FileSearchResult> => {
    return deps.searchFiles(event.sender.id, input)
  })

  ipcMain.handle('fs:search-content', async (event, input: ContentSearchRequest): Promise<ContentSearchResult> => {
    return deps.searchContent(event.sender.id, input)
  })

  ipcMain.handle('fs:cancel-content-search', (event): void => {
    deps.cancelActiveContentSearch(event.sender.id)
  })
}
