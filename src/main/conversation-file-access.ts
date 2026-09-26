import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Open an existing regular file, then verify the descriptor before any I/O.
 * O_NOFOLLOW protects the leaf; checking ancestors and inode again detects
 * directory replacement during open. Creation requires a native anchored open
 * primitive and deliberately is not exposed through this helper.
 * This is descriptor verification, not a kernel sandbox: repeated malicious
 * ancestor rename/restore races require native openat traversal to eliminate.
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

/** Read through short reads, reject growth, and avoid mixing a changing file. */
export async function readBoundedConversationFile(file: FileHandle, limit: number): Promise<Buffer> {
  const before = await file.stat()
  if (!before.isFile() || before.size > limit) throw new Error('File exceeds the conversation read limit.')
  const buffer = Buffer.alloc(limit + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  const after = await file.stat()
  if (offset > limit || after.size > limit) throw new Error('File exceeds the conversation read limit.')
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || offset !== after.size)
    throw new Error('File changed while reading it. Retry after filesystem changes have stopped.')
  return buffer.subarray(0, offset)
}
