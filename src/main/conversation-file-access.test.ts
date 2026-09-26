import { expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConfinedExistingFile, readBoundedConversationFile } from './conversation-file-access'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

test('bounded reads continue after short reads and reject file growth', async () => {
  let size = 6
  const file = {
    stat: async () => ({ isFile: () => true, size, mtimeMs: 1 }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const source = Buffer.from('abcdef')
      const bytesRead = Math.max(0, Math.min(2, length, source.length - position))
      source.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead, buffer }
    },
  }
  expect((await readBoundedConversationFile(file as unknown as Awaited<ReturnType<typeof open>>, 8)).toString()).toBe(
    'abcdef',
  )
  const read = file.read
  file.read = async (...args) => {
    const value = await read(...args)
    size = 7
    return value
  }
  await expect(readBoundedConversationFile(file as unknown as Awaited<ReturnType<typeof open>>, 8)).rejects.toThrow(
    'changed while reading',
  )
})

test('confined descriptors reject symlink swaps before any read or write and refuse creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-file-access-'))
  const root = join(directory, 'workspace'),
    outside = join(directory, 'outside'),
    parent = join(root, 'nested')
  await mkdir(parent, { recursive: true })
  await mkdir(outside)
  await writeFile(join(parent, 'file.txt'), 'workspace')
  await writeFile(join(outside, 'file.txt'), 'private')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    const file = await openConfinedExistingFile(root, 'nested/file.txt')
    expect(await file.readFile('utf8')).toBe('workspace')
    await file.close()
    await expect(openConfinedExistingFile(root, '../outside/file.txt')).rejects.toThrow('outside')
    await expect(openConfinedExistingFile(root, 'missing.txt', 'write')).rejects.toMatchObject({ code: 'ENOENT' })
    for (const access of ['read', 'write'] as const) {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        await rename(parent, `${parent}-saved`)
        await symlink(outside, parent, 'dir')
        return actual.open(...args)
      })
      await expect(openConfinedExistingFile(root, 'nested/file.txt', access)).rejects.toThrow('Symbolic links')
      expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('private')
      await rm(parent)
      await rename(`${parent}-saved`, parent)
    }
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(parent, `${parent}-saved`)
      await symlink(outside, parent, 'dir')
      const descriptor = await actual.open(...args)
      await rm(parent)
      await rename(`${parent}-saved`, parent)
      return descriptor
    })
    await expect(openConfinedExistingFile(root, 'nested/file.txt')).rejects.toThrow('changed while opening')
  } finally {
    vi.mocked(open).mockReset().mockImplementation(actual.open)
    await rm(directory, { recursive: true, force: true })
  }
})
