import { expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConfinedExistingFile } from './conversation-file-access'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
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
