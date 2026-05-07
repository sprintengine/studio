import type { IpcMain } from 'electron'
import type { WorkspaceFolderCheckResult } from '../../shared/electron-api'

export type FileSystemDirectoryEntry = {
  name: string
  isDir: boolean
}

type FilesystemReadIpcDependencies = {
  readDirectory(dirPath: string): Promise<FileSystemDirectoryEntry[]>
  readTextFile(filePath: string): Promise<string>
  readImageDataUrl(filePath: string): Promise<string>
  pathExists(targetPath: string): Promise<boolean>
  checkWorkspaceFolder(targetPath: string): Promise<WorkspaceFolderCheckResult>
  showItemInFolder(targetPath: string): Promise<void>
}

export function registerFilesystemReadIpc(ipcMain: IpcMain, deps: FilesystemReadIpcDependencies): void {
  ipcMain.handle('fs:readdir', async (_, dirPath: string): Promise<FileSystemDirectoryEntry[]> => {
    return deps.readDirectory(dirPath)
  })

  ipcMain.handle('fs:readfile', async (_, filePath: string): Promise<string> => {
    return deps.readTextFile(filePath)
  })

  ipcMain.handle('fs:read-image-data-url', async (_, filePath: string): Promise<string> => {
    return deps.readImageDataUrl(filePath)
  })

  ipcMain.handle('fs:path-exists', async (_, targetPath: string): Promise<boolean> => {
    return deps.pathExists(targetPath)
  })

  ipcMain.handle('fs:check-workspace-folder', async (_, targetPath: string): Promise<WorkspaceFolderCheckResult> => {
    return deps.checkWorkspaceFolder(targetPath)
  })

  ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string): Promise<void> => {
    await deps.showItemInFolder(targetPath)
  })
}
