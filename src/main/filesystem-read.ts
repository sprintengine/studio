import { shell } from 'electron'
import { access, readdir, readFile } from 'fs/promises'
import { imageMimeType } from './filesystem-image'
import { checkWorkspaceFolder, pathExists } from './filesystem-workspace'

export function createFilesystemReadHandlers() {
  return {
    async readDirectory(dirPath: string) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    },
    async readTextFile(filePath: string) {
      return readFile(filePath, 'utf-8')
    },
    async readImageDataUrl(filePath: string) {
      const mimeType = imageMimeType(filePath)
      if (!mimeType) throw new Error('Unsupported image file type.')
      const content = await readFile(filePath)
      return `data:${mimeType};base64,${content.toString('base64')}`
    },
    pathExists,
    checkWorkspaceFolder,
    async showItemInFolder(targetPath: string) {
      await access(targetPath)
      shell.showItemInFolder(targetPath)
    },
  }
}
