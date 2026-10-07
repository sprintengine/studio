import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  createAttachedFileRegistry,
  createAttachedFiles,
  createAttachedFileThumbnails,
  isAttachablePath,
  MAX_CACHED_THUMBNAILS,
  MAX_THUMBNAIL_SOURCE_BYTES,
  THUMBNAIL_SIZE,
} from './attached-files'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprintengine-attached-files-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

const image = (url: string) => ({ isEmpty: () => false, toDataURL: () => url })

function setup(options: { platform?: NodeJS.Platform; openPath?: (path: string) => Promise<string> } = {}) {
  const platform = options.platform ?? 'darwin'
  const registry = createAttachedFileRegistry({ resolveUserDataDir: () => root })
  const createThumbnail = vi.fn(async (path: string) => image(`data:image/png;base64,${path.length}`))
  const openPath = vi.fn(options.openPath ?? (async () => ''))
  const files = createAttachedFiles({
    registry,
    thumbnails: createAttachedFileThumbnails({ platform, createThumbnail }),
    platform,
    openPath,
  })
  return { registry, files, createThumbnail, openPath }
}

async function file(name: string, content = 'x', mode?: number): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content)
  if (mode !== undefined) await chmod(path, mode)
  return path
}

test('a path over IPC must be absolute, bounded and free of control characters', () => {
  expect(isAttachablePath('/Users/dev/report.pdf')).toBe(true)
  expect(isAttachablePath('C:\\Users\\dev\\report.pdf')).toBe(true)
  expect(isAttachablePath('report.pdf')).toBe(false)
  expect(isAttachablePath('/Users/dev/re\nport.pdf')).toBe(false)
  expect(isAttachablePath(`/${'a'.repeat(5000)}`)).toBe(false)
  expect(isAttachablePath(42)).toBe(false)
})

test('the attached list outlives a restart, newest kept, and only remembers real paths', async () => {
  const first = createAttachedFileRegistry({ resolveUserDataDir: () => root, limit: 2 })
  first.register('/Users/dev/a.pdf')
  first.register('/Users/dev/b.pdf')
  first.register('relative.pdf')
  // Attaching again moves a path to the newest end, so the cap drops the stalest.
  first.register('/Users/dev/a.pdf')
  first.register('/Users/dev/c.pdf')
  expect(first.has('/Users/dev/b.pdf'), 'the least recently attached is dropped at the cap').toBe(false)
  const restarted = createAttachedFileRegistry({ resolveUserDataDir: () => root, limit: 2 })
  expect(restarted.has('/Users/dev/a.pdf')).toBe(true)
  expect(restarted.has('/Users/dev/c.pdf')).toBe(true)
  expect(restarted.has('relative.pdf')).toBe(false)
  expect(JSON.parse(await readFile(join(root, 'attached-files.json'), 'utf8'))).toEqual({
    paths: ['/Users/dev/a.pdf', '/Users/dev/c.pdf'],
  })
})

test('an unreadable list starts empty rather than failing', async () => {
  await writeFile(join(root, 'attached-files.json'), '{not json')
  const registry = createAttachedFileRegistry({ resolveUserDataDir: () => root })
  expect(registry.has('/Users/dev/a.pdf')).toBe(false)
  registry.register('/Users/dev/a.pdf')
  expect(registry.has('/Users/dev/a.pdf')).toBe(true)
})

test('an attached document opens in its default app', async () => {
  const { files, openPath } = setup()
  const path = await file('Quarterly report.pdf')
  files.register(path)
  await files.open(path)
  expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/Quarterly report\.pdf$/))
})

test('a path nobody attached is not opened, whatever it is', async () => {
  const { files, openPath } = setup()
  const path = await file('elsewhere.pdf')
  await expect(files.open(path)).rejects.toThrow(
    'elsewhere.pdf was not attached here, so it can only be shown in Finder.',
  )
  expect(openPath).not.toHaveBeenCalled()
})

// POSIX links and modes; Windows decides by the name alone, which the test above covers.
test.skipIf(process.platform === 'win32')(
  'a file that would run is refused even when attached: by name, through a link, and by its executable bit',
  async () => {
    const { files, openPath } = setup()
    const script = await file('deploy.sh', '#!/bin/sh\n')
    files.register(script)
    await expect(files.open(script)).rejects.toThrow('deploy.sh would run as a program, so it is only shown in Finder.')

    // A link named like a document opens what it points at, so that is judged.
    const disguised = join(root, 'notes.txt')
    await symlink(script, disguised)
    files.register(disguised)
    await expect(files.open(disguised)).rejects.toThrow('would run as a program')

    // With no extension the system decides by the executable bit: a terminal would run it.
    const bare = await file('tool', '#!/bin/sh\n', 0o755)
    files.register(bare)
    await expect(files.open(bare)).rejects.toThrow('would run as a program')
    expect(openPath).not.toHaveBeenCalled()
  },
)

test('a folder, a bundle and a file that has gone are refused, in words', async () => {
  const { files } = setup()
  const folder = join(root, 'Reports')
  await mkdir(folder)
  files.register(folder)
  await expect(files.open(folder)).rejects.toThrow('Reports is not a file.')
  const bundle = join(root, 'Calculator.app')
  await mkdir(bundle)
  files.register(bundle)
  await expect(files.open(bundle)).rejects.toThrow('would run as a program')
  const gone = join(root, 'gone.pdf')
  files.register(gone)
  await expect(files.open(gone)).rejects.toThrow('gone.pdf is no longer there.')
})

test('the system’s refusal to open a file is the error the card shows', async () => {
  const { files } = setup({ openPath: async () => 'No application knows how to open this file.' })
  const path = await file('data.weird')
  files.register(path)
  await expect(files.open(path)).rejects.toThrow('No application knows how to open this file.')
})

test('a preview says what the path is, draws a thumbnail only for an attached file, and says whether it opens', async () => {
  const { files, createThumbnail } = setup()
  const pdf = await file('report.pdf')
  expect(await files.preview(pdf), 'a path merely named is not shown to the thumbnailer').toEqual({
    kind: 'file',
    thumbnailDataUrl: null,
    openable: false,
  })
  expect(createThumbnail).not.toHaveBeenCalled()
  files.register(pdf)
  expect(await files.preview(pdf)).toEqual({
    kind: 'file',
    thumbnailDataUrl: `data:image/png;base64,${pdf.length}`,
    openable: true,
  })
  expect(createThumbnail).toHaveBeenCalledWith(pdf, { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE })
  const script = await file('run.command')
  files.register(script)
  expect((await files.preview(script)).openable).toBe(false)
  const folder = join(root, 'Docs')
  await mkdir(folder)
  expect(await files.preview(folder)).toEqual({ kind: 'folder', thumbnailDataUrl: null, openable: false })
  expect(await files.preview(join(root, 'nothing.pdf'))).toEqual({
    kind: 'missing',
    thumbnailDataUrl: null,
    openable: false,
  })
})

test('thumbnails are cached by path, size and modification time; a changed file is drawn again', async () => {
  const createThumbnail = vi.fn(async () => image('data:image/png;base64,AAAA'))
  const thumbnails = createAttachedFileThumbnails({ platform: 'win32', createThumbnail })
  const stamp = { size: 10, mtimeMs: 1 }
  expect(await thumbnails.thumbnail('/Users/dev/a.pdf', stamp)).toBe('data:image/png;base64,AAAA')
  await thumbnails.thumbnail('/Users/dev/a.pdf', stamp)
  // Asked twice at once, drawn once.
  await Promise.all([thumbnails.thumbnail('/Users/dev/b.pdf', stamp), thumbnails.thumbnail('/Users/dev/b.pdf', stamp)])
  expect(createThumbnail).toHaveBeenCalledTimes(2)
  await thumbnails.thumbnail('/Users/dev/a.pdf', { size: 10, mtimeMs: 2 })
  expect(createThumbnail).toHaveBeenCalledTimes(3)
})

test('the cache keeps its most recently used thumbnails', async () => {
  const createThumbnail = vi.fn(async (path: string) => image(path))
  const thumbnails = createAttachedFileThumbnails({ platform: 'darwin', createThumbnail })
  const stamp = { size: 1, mtimeMs: 1 }
  await thumbnails.thumbnail('/Users/dev/first.pdf', stamp)
  for (let index = 0; index < MAX_CACHED_THUMBNAILS; index++) {
    // Reading the first keeps it fresh while the rest fill the cache.
    await thumbnails.thumbnail('/Users/dev/first.pdf', stamp)
    await thumbnails.thumbnail(`/Users/dev/${index}.pdf`, stamp)
  }
  createThumbnail.mockClear()
  await thumbnails.thumbnail('/Users/dev/first.pdf', stamp)
  expect(createThumbnail, 'the one read last is still cached').not.toHaveBeenCalled()
  await thumbnails.thumbnail('/Users/dev/0.pdf', stamp)
  expect(createThumbnail, 'the stalest has gone').toHaveBeenCalledOnce()
})

test('a thumbnail that is slow, fails or comes back empty leaves the card on its glyph', async () => {
  vi.useFakeTimers()
  const slow = createAttachedFileThumbnails({
    platform: 'darwin',
    createThumbnail: () => new Promise(() => undefined),
    timeoutMs: 50,
  })
  const pending = slow.thumbnail('/Users/dev/huge.key', { size: 1, mtimeMs: 1 })
  await vi.advanceTimersByTimeAsync(50)
  expect(await pending).toBeNull()
  vi.useRealTimers()

  const failing = createAttachedFileThumbnails({
    platform: 'darwin',
    createThumbnail: async () => {
      throw new Error('Quick Look could not draw it')
    },
  })
  expect(await failing.thumbnail('/Users/dev/odd.bin', { size: 1, mtimeMs: 1 })).toBeNull()

  const empty = createAttachedFileThumbnails({
    platform: 'darwin',
    createThumbnail: async () => ({ isEmpty: () => true, toDataURL: () => 'data:,' }),
  })
  expect(await empty.thumbnail('/Users/dev/blank.pdf', { size: 1, mtimeMs: 1 })).toBeNull()
})

test('Linux draws no thumbnails, and a huge file is not handed to the thumbnailer', async () => {
  const createThumbnail = vi.fn(async () => image('data:image/png;base64,AAAA'))
  const linux = createAttachedFileThumbnails({ platform: 'linux', createThumbnail })
  expect(await linux.thumbnail('/home/dev/a.pdf', { size: 1, mtimeMs: 1 })).toBeNull()
  const mac = createAttachedFileThumbnails({ platform: 'darwin', createThumbnail })
  expect(await mac.thumbnail('/Users/dev/movie.mov', { size: MAX_THUMBNAIL_SOURCE_BYTES + 1, mtimeMs: 1 })).toBeNull()
  expect(createThumbnail).not.toHaveBeenCalled()
})
