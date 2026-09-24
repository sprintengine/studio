import { BrowserWindow, type IpcMain } from 'electron'
import type { ContentSearchResult, FileSearchResult, FileWatchEvent } from '../../shared/electron-api'
import { getWatchHub, type WatchHub, type WatchSubscription } from '../workspace-watch-hub'

type FileSearchRequest = {
  rootPath: string
  query: string
  limit?: number
}

type ContentSearchRequest = FileSearchRequest

type FileWatcherRecord = {
  subscription: WatchSubscription
  senderId: number
}

type FilesystemWatchSearchIpcDependencies = {
  pathExists(targetPath: string): Promise<boolean>
  isMissingPathError(error: unknown): boolean
  searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult>
  searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult>
  cancelActiveContentSearch(senderId: number): void
  /** Injectable for tests; the process-wide hub otherwise. */
  watchHub?: WatchHub
}

export type FileWatchStartOptions = {
  /** Deliver events under `.git/`, `node_modules/`, `.sprintengine/` and build output too. */
  includeIgnored?: boolean
}

export function registerFilesystemWatchSearchIpc(ipcMain: IpcMain, deps: FilesystemWatchSearchIpcDependencies): void {
  const hub = deps.watchHub ?? getWatchHub()
  const fileWatchers = new Map<string, FileWatcherRecord>()
  const trackedWatcherSenders = new Set<number>()
  let nextFileWatcherId = 0

  const disposeFileWatcher = (watchId: string): void => {
    const fileWatcher = fileWatchers.get(watchId)
    if (!fileWatcher) return
    fileWatcher.subscription.close()
    fileWatchers.delete(watchId)
  }

  const disposeFileWatchersForSender = (senderId: number): void => {
    for (const [watchId, fileWatcher] of fileWatchers.entries()) {
      if (fileWatcher.senderId === senderId) disposeFileWatcher(watchId)
    }
  }

  const sendFileWatchEvent = (watchId: string, senderId: number, watchEvent: FileWatchEvent): void => {
    if (!fileWatchers.has(watchId)) return
    const sender = BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .find((webContents) => webContents.id === senderId)
    if (!sender || sender.isDestroyed()) return
    sender.send(`fs:watch-event:${watchId}`, watchEvent)
  }

  ipcMain.handle(
    'fs:watch-start',
    async (event, dirPath: string, options?: FileWatchStartOptions): Promise<string | null> => {
      const senderId = event.sender.id
      if (!trackedWatcherSenders.has(senderId)) {
        trackedWatcherSenders.add(senderId)
        event.sender.once('destroyed', () => {
          trackedWatcherSenders.delete(senderId)
          disposeFileWatchersForSender(senderId)
        })
      }

      if (!(await deps.pathExists(dirPath))) return null

      const watchId = `watch-${++nextFileWatcherId}`
      try {
        const subscription = hub.subscribe(dirPath, (watchEvent) => sendFileWatchEvent(watchId, senderId, watchEvent), {
          includeIgnored: options?.includeIgnored === true,
        })
        fileWatchers.set(watchId, { subscription, senderId })
        return watchId
      } catch (error) {
        if (deps.isMissingPathError(error)) return null
        throw error
      }
    },
  )

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
