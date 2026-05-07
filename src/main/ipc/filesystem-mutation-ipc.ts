import type { IpcMain } from 'electron'
import { cp, mkdir, rename, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

type FilesystemMutationIpcDependencies = {
  assertNotDirectSwarmStateMutation(targetPath: string): Promise<void>
  getUniqueCopyPath(destinationDir: string, sourceName: string, sourcePath: string): Promise<string>
  pathExists(targetPath: string): Promise<boolean>
  trashItem(targetPath: string): Promise<void>
}

export function registerFilesystemMutationIpc(ipcMain: IpcMain, deps: FilesystemMutationIpcDependencies): void {
  ipcMain.handle('fs:writefile', async (_, filePath: string, content: string): Promise<void> => {
    await deps.assertNotDirectSwarmStateMutation(filePath)
    await writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string): Promise<string> => {
    const filePath = join(parentDir, name)
    await deps.assertNotDirectSwarmStateMutation(filePath)
    await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
    return filePath
  })

  ipcMain.handle('fs:create-dir', async (_, parentDir: string, name: string): Promise<string> => {
    const dirPath = join(parentDir, name)
    await mkdir(dirPath)
    return dirPath
  })

  ipcMain.handle('fs:ensure-dir', async (_, parentDir: string, name: string): Promise<string> => {
    const dirPath = join(parentDir, name)
    await mkdir(dirPath, { recursive: true })
    return dirPath
  })

  ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string): Promise<string> => {
    const normalizedName = nextName.trim()
    if (!normalizedName || normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
      throw new Error('Enter a valid file or folder name.')
    }

    const targetPath = join(dirname(sourcePath), normalizedName)
    if (targetPath === sourcePath) return targetPath
    await deps.assertNotDirectSwarmStateMutation(sourcePath)
    await deps.assertNotDirectSwarmStateMutation(targetPath)

    if (await deps.pathExists(targetPath)) {
      throw new Error(`A file or folder named "${normalizedName}" already exists.`)
    }

    await rename(sourcePath, targetPath)
    return targetPath
  })

  ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string): Promise<string> => {
    const sourceName = basename(sourcePath)
    const destinationPath = await deps.getUniqueCopyPath(destinationDir, sourceName, sourcePath)
    await deps.assertNotDirectSwarmStateMutation(sourcePath)
    await deps.assertNotDirectSwarmStateMutation(destinationPath)

    await cp(sourcePath, destinationPath, {
      errorOnExist: true,
      force: false,
      recursive: true,
    })

    return destinationPath
  })

  ipcMain.handle('fs:delete', async (_, targetPath: string): Promise<void> => {
    await deps.assertNotDirectSwarmStateMutation(targetPath)
    await deps.trashItem(targetPath)
  })
}
