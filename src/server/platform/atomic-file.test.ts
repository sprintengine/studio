import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { writeFileAtomic, writeFileAtomicSync } from './atomic-file'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-file-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.each([
  ['writeFileAtomic', writeFileAtomic],
  ['writeFileAtomicSync', async (...args: Parameters<typeof writeFileAtomicSync>) => writeFileAtomicSync(...args)],
] as const)('%s', (_name, write) => {
  test('replaces an existing file whole and leaves no temporary file behind', async () => {
    const path = join(dir, 'store.json')
    await writeFile(path, 'old contents that are longer than the new ones')
    await write(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['store.json'])
  })

  test('a write that fails removes its temporary file and rethrows', async () => {
    // Renaming a file over a directory fails on every platform.
    const path = join(dir, 'taken')
    await mkdir(join(path, 'inner'), { recursive: true })
    await expect(write(path, 'data')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['taken'])
  })

  test.skipIf(process.platform === 'win32')('exactMode sets the permission bits the umask would mask', async () => {
    const path = join(dir, 'secret.json')
    const previous = process.umask(0o077)
    try {
      await write(path, '{}', { mode: 0o640, exactMode: true })
    } finally {
      process.umask(previous)
    }
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  test.skipIf(process.platform === 'win32')('without exactMode the umask still applies to the mode', async () => {
    const path = join(dir, 'masked.json')
    const previous = process.umask(0o077)
    try {
      await write(path, '{}', { mode: 0o640 })
    } finally {
      process.umask(previous)
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
