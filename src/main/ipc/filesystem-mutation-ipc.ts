import type { IpcMain } from 'electron'
import { randomUUID } from 'crypto'
import { cp, mkdir, rename, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

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

function normalizeRenamedFileSystemEntryName(rawName: string): string {
  if (/[. ]$/u.test(rawName)) {
    throw new Error('File and folder names cannot end with a period or space.')
  }
  const name = rawName.trim()
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error('Enter a valid file or folder name.')
  }
  if (/[\u0000-\u001f<>:"|?*]/u.test(name)) {
    throw new Error('File and folder names cannot contain control characters or <>:"|?*.')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
    throw new Error('That file or folder name is reserved by Windows.')
  }
  return name
}

// The same image set the conversation composer stages
// (shared/conversation-attachments.ts), keyed to the extension the saved file
// wears — agents and previewers alike read the type off the name.
const DROPPED_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// Not a vision-model budget — the file goes to disk and is read by path. This
// only bounds a runaway IPC payload; a real screenshot is far under it.
const MAX_DROPPED_IMAGE_BYTES = 32 * 1024 * 1024

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath)
  const parent = resolve(parentPath)
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

  ipcMain.handle(
    'fs:save-dropped-image',
    async (_, input: { mediaType?: unknown; dataBase64?: unknown }): Promise<string> => {
      const mediaType = typeof input?.mediaType === 'string' ? input.mediaType : ''
      const extension = DROPPED_IMAGE_EXTENSIONS[mediaType]
      if (!extension) throw new Error('Only PNG, JPEG, WebP, and GIF images can be attached.')
      if (typeof input.dataBase64 !== 'string') throw new Error('That image could not be read.')
      const bytes = Buffer.from(input.dataBase64, 'base64')
      if (bytes.length === 0) throw new Error('That image could not be read.')
      if (bytes.length > MAX_DROPPED_IMAGE_BYTES) throw new Error('That image is too large to attach.')

      const directory = join(tmpdir(), 'multicode-images')
      await mkdir(directory, { recursive: true })
      // `wx` + a random tail: two pastes in the same instant are two files,
      // never one silently overwriting the other.
      const filePath = join(directory, `pasted-${randomUUID().slice(0, 8)}.${extension}`)
      await writeFile(filePath, bytes, { flag: 'wx' })
      return filePath
    }
  )

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
    const normalizedName = normalizeRenamedFileSystemEntryName(nextName)

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

  ipcMain.handle('fs:move', async (_, sourcePath: string, destinationDir: string): Promise<string> => {
    if (isPathInsideOrEqual(destinationDir, sourcePath)) {
      throw new Error('Cannot move a file or folder into itself.')
    }

    const sourceName = basename(sourcePath)
    const destinationPath = join(destinationDir, sourceName)
    if (destinationPath === sourcePath) return sourcePath

    await deps.assertNotDirectSprintEngineStateMutation(sourcePath)
    await deps.assertNotDirectSprintEngineStateMutation(destinationPath)

    if (await deps.pathExists(destinationPath)) {
      throw new Error(`A file or folder named "${sourceName}" already exists.`)
    }

    await rename(sourcePath, destinationPath)
    return destinationPath
  })

  ipcMain.handle('fs:delete', async (_, targetPath: string): Promise<void> => {
    await deps.trashItem(targetPath)
  })
}
