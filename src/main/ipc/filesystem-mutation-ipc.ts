import type { IpcMain } from 'electron'
import { cp, mkdir, rename, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

type FilesystemMutationIpcDependencies = {
  assertNotDirectSprintEngineStateMutation(targetPath: string): Promise<void>
  getUniqueCopyPath(destinationDir: string, sourceName: string, sourcePath: string): Promise<string>
  pathExists(targetPath: string): Promise<boolean>
  trashItem(targetPath: string): Promise<void>
}

function normalizeNewWorkspaceFolderName(rawName: string): string {
  const name = rawName.trim()
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error('Enter a valid folder name.')
  }
  if (/[\u0000-\u001f<>:"|?*]/u.test(name)) {
    throw new Error('Folder names cannot contain control characters or <>:"|?*.')
  }
  if (/[. ]$/u.test(name)) {
    throw new Error('Folder names cannot end with a period or space.')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
    throw new Error('That folder name is reserved by Windows.')
  }
  return name
}

export function registerFilesystemMutationIpc(ipcMain: IpcMain, deps: FilesystemMutationIpcDependencies): void {
  ipcMain.handle('fs:writefile', async (_, filePath: string, content: string): Promise<void> => {
    await deps.assertNotDirectSprintEngineStateMutation(filePath)
    await writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('fs:write-binary-file', async (_, filePath: string, base64Content: string): Promise<void> => {
    await deps.assertNotDirectSprintEngineStateMutation(filePath)
    await writeFile(filePath, Buffer.from(base64Content, 'base64'))
  })

  ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string): Promise<string> => {
    const filePath = join(parentDir, name)
    await deps.assertNotDirectSprintEngineStateMutation(filePath)
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

  ipcMain.handle('fs:create-workspace-folder', async (_, parentDir: string, name: string): Promise<string> => {
    const normalizedName = normalizeNewWorkspaceFolderName(name)
    const dirPath = join(parentDir, normalizedName)
    if (await deps.pathExists(dirPath)) {
      throw new Error(`A folder named "${normalizedName}" already exists.`)
    }
    await mkdir(dirPath)
    return dirPath
  })

  ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string): Promise<string> => {
    const normalizedName = nextName.trim()
    if (!normalizedName || normalizedName === '.' || normalizedName === '..' || /[/\\]/.test(normalizedName)) {
      throw new Error('Enter a valid file or folder name.')
    }

    const targetPath = join(dirname(sourcePath), normalizedName)
    if (targetPath === sourcePath) return targetPath
    await deps.assertNotDirectSprintEngineStateMutation(sourcePath)
    await deps.assertNotDirectSprintEngineStateMutation(targetPath)

    if (await deps.pathExists(targetPath)) {
      throw new Error(`A file or folder named "${normalizedName}" already exists.`)
    }

    await rename(sourcePath, targetPath)
    return targetPath
  })

  ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string): Promise<string> => {
    const sourceName = basename(sourcePath)
    const destinationPath = await deps.getUniqueCopyPath(destinationDir, sourceName, sourcePath)
    await deps.assertNotDirectSprintEngineStateMutation(sourcePath)
    await deps.assertNotDirectSprintEngineStateMutation(destinationPath)

    await cp(sourcePath, destinationPath, {
      errorOnExist: true,
      force: false,
      recursive: true,
    })

    return destinationPath
  })

  ipcMain.handle('fs:copy-into', async (_, sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }): Promise<string> => {
    const destinationPath = join(destinationDir, basename(sourcePath))
    const overwrite = options?.overwrite === true
    await deps.assertNotDirectSprintEngineStateMutation(sourcePath)
    await deps.assertNotDirectSprintEngineStateMutation(destinationPath)

    if (!overwrite && await deps.pathExists(destinationPath)) {
      throw new Error(`A file or folder named "${basename(sourcePath)}" already exists.`)
    }

    await cp(sourcePath, destinationPath, {
      errorOnExist: !overwrite,
      force: overwrite,
      recursive: true,
    })

    return destinationPath
  })

  ipcMain.handle('fs:delete', async (_, targetPath: string): Promise<void> => {
    await deps.assertNotDirectSprintEngineStateMutation(targetPath)
    await deps.trashItem(targetPath)
  })
}
