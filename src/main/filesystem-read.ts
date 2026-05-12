import { shell } from 'electron'
import { access, readdir, readFile, stat } from 'fs/promises'
import { extname } from 'path'
import { pathToFileURL } from 'url'
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
    async openHtmlFileInBrowser(targetPath: string) {
      const extension = extname(targetPath).toLowerCase()
      if (extension !== '.html' && extension !== '.htm') {
        throw new Error('Only HTML files can be opened in the browser.')
      }

      const targetStats = await stat(targetPath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be opened in the browser.')
      }

      await shell.openExternal(pathToFileURL(targetPath).toString())
    },
  }
}
