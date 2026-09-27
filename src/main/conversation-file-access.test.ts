import { expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openConfinedExistingFile, readBoundedConversationFile } from './conversation-file-access'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

type Handle = Awaited<ReturnType<typeof open>>

function fakeFile(content: string) {
  const state = { size: content.length, mtimeMs: 1, onRead: () => {} }
  const file = {
    stat: async () => ({ isFile: () => true, size: state.size, mtimeMs: state.mtimeMs }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const source = Buffer.from(content)
      const bytesRead = Math.max(0, Math.min(2, length, source.length - position))
      source.copy(buffer, offset, position, position + bytesRead)
      state.onRead()
      return { bytesRead, buffer }
    },
  }
  return { file: file as unknown as Handle, state }
}

test('bounded reads continue after short reads', async () => {
  const { file } = fakeFile('abcdef')
  expect((await readBoundedConversationFile(file, 8)).toString()).toBe('abcdef')
  await expect(readBoundedConversationFile(file, 5)).rejects.toThrow('read limit')
})

test('an append that lands mid-read is left for the next read instead of failing this one', async () => {
  const { file, state } = fakeFile('abcdef')
  state.onRead = () => {
    state.size = 9
    state.mtimeMs = 2
  }
  expect((await readBoundedConversationFile(file, 8)).toString()).toBe('abcdef')
})

test('a file that shrinks or is rewritten in place mid-read is refused', async () => {
  const shrinking = fakeFile('abcdef')
  shrinking.state.onRead = () => {
    shrinking.state.size = 3
  }
  await expect(readBoundedConversationFile(shrinking.file, 8)).rejects.toThrow('changed while reading')
  const rewritten = fakeFile('abcdef')
  rewritten.state.onRead = () => {
    rewritten.state.mtimeMs = 2
  }
  await expect(readBoundedConversationFile(rewritten.file, 8)).rejects.toThrow('changed while reading')
})

test('a real transcript appended to while it is read returns the bytes present at the start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-file-access-append-'))
  try {
    const path = join(directory, 'log.jsonl')
    await writeFile(path, 'one\ntwo\n')
    const file = await open(path, 'r')
    const writer = await open(path, 'a')
    try {
      const read = file.read.bind(file)
      let appended = false
      file.read = (async (...args: Parameters<typeof read>) => {
        if (!appended) {
          appended = true
          await writer.writeFile('three\n')
        }
        return read(...args)
      }) as typeof file.read
      expect((await readBoundedConversationFile(file, 1024)).toString()).toBe('one\ntwo\n')
    } finally {
      await writer.close()
      await file.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
