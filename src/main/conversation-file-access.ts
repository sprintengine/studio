import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Open an existing regular file, then verify the descriptor before any I/O.
 * O_NOFOLLOW protects the leaf; checking ancestors and inode again detects
 * directory replacement during open. Creation requires a native anchored open
 * primitive and deliberately is not exposed through this helper.
 */
export async function openConfinedExistingFile(
  workspaceRoot: string,
  requestedPath: string,
  access: 'read' | 'write' = 'read',
): Promise<FileHandle> {
  const root = await realpath(workspaceRoot)
  const target = resolve(root, requestedPath)
  const suffix = relative(root, target)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error('File path is outside the conversation workspace.')
  const inspect = async () => {
    let path = root
    const parents: Array<{ dev: number; ino: number }> = []
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Workspace directory changed.')
    parents.push({ dev: rootInfo.dev, ino: rootInfo.ino })
    const parts = suffix.split(sep)
    for (let index = 0; index < parts.length; index++) {
      path = resolve(path, parts[index])
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not available through conversation file access.')
      if (index === parts.length - 1) {
        if (!info.isFile())
          throw new Error('Only existing regular files are available through conversation file access.')
        return { info, parents }
      }
      if (!info.isDirectory()) throw new Error('File parent is not a directory.')
      parents.push({ dev: info.dev, ino: info.ino })
    }
    throw new Error('File path is invalid.')
  }
  const before = await inspect()
  const file = await open(
    target,
    (access === 'write' ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const opened = await file.stat()
    const after = await inspect()
    if (
      !opened.isFile() ||
      opened.dev !== before.info.dev ||
      opened.ino !== before.info.ino ||
      opened.dev !== after.info.dev ||
      opened.ino !== after.info.ino ||
      JSON.stringify(before.parents) !== JSON.stringify(after.parents) ||
      (await realpath(target)) !== target
    )
      throw new Error('File path changed while opening it. Retry after filesystem changes have stopped.')
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}
