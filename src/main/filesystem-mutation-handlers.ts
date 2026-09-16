import { shell } from 'electron'
import { getUniqueCopyPath } from './filesystem-copy'
import { pathExists } from './filesystem-workspace'

export function createFilesystemMutationHandlers() {
  return {
    getUniqueCopyPath: (destinationDir: string, sourceName: string, sourcePath: string) =>
      getUniqueCopyPath(destinationDir, sourceName, sourcePath, pathExists),
    pathExists,
    async trashItem(targetPath: string) {
      await shell.trashItem(targetPath)
    },
  }
}
