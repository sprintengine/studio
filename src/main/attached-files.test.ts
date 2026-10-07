import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Every look at the disk goes through this spy, so a test can say a path was
// never looked at.
const statCalls = vi.hoisted(() => [] as string[])
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: (path: string, ...rest: unknown[]) => {
      statCalls.push(path)
      return (actual.stat as (...args: unknown[]) => unknown)(path, ...rest)
    },
  }
})

import {
  createAttachedFileRegistry,
  createAttachedFiles,
  createAttachedFileThumbnails,
  isAttachablePath,
  MAX_CACHED_THUMBNAILS,
  MAX_THUMBNAIL_SOURCE_BYTES,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_SIZE,
} from './attached-files'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprintengine-attached-files-'))
  statCalls.length = 0
})

// Every registry a test made, so a write still waiting lands before its folder goes.
const registries: { flush(): void }[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const registry of registries.splice(0)) registry.flush()
  await rm(root, { recursive: true, force: true })
})

const image = (url: string) => ({ isEmpty: () => false, toDataURL: () => url })

function setup(options: { platform?: NodeJS.Platform; openPath?: (path: string) => Promise<string> } = {}) {
  const platform = options.platform ?? 'darwin'
  const registry = createAttachedFileRegistry({ resolveUserDataDir: () => root, writeDelayMs: 0 })
  registries.push(registry)
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
  first.flush()
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
  registry.flush()
})

test('a drop of many files is one write, a moment later; flush writes what is waiting at once', async () => {
  vi.useFakeTimers()
  const registry = createAttachedFileRegistry({ resolveUserDataDir: () => root, writeDelayMs: 100 })
  const stored = join(root, 'attached-files.json')
  for (let index = 0; index < 30; index++) registry.register(`/Users/dev/${index}.pdf`)
  await expect(readFile(stored, 'utf8'), 'nothing is written while the drop is still landing').rejects.toThrow()
  vi.advanceTimersByTime(100)
  expect(JSON.parse(await readFile(stored, 'utf8')).paths).toHaveLength(30)
  registry.register('/Users/dev/late.pdf')
  registry.flush()
  expect(JSON.parse(await readFile(stored, 'utf8')).paths.at(-1)).toBe('/Users/dev/late.pdf')
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

test('only a kind on the list opens; anything else is refused even when attached', async () => {
  const { files, openPath } = setup()
  const script = await file('deploy.sh', '#!/bin/sh\n')
  files.register(script)
  await expect(files.open(script)).rejects.toThrow(
    'deploy.sh is not a kind of file this app opens, so it is only shown in Finder.',
  )
  const plain = await file('NOTES')
  files.register(plain)
  await expect(files.open(plain), 'a name that says nothing about what it is').rejects.toThrow(
    'is not a kind of file this app opens',
  )
  expect(openPath).not.toHaveBeenCalled()
})

// POSIX links; Windows links need a privilege a test run does not have.
test.skipIf(process.platform === 'win32')('a link named like a document is judged by what it points at', async () => {
  const { files, openPath } = setup()
  const script = await file('deploy.sh', '#!/bin/sh\n')
  const disguised = join(root, 'notes.txt')
  await symlink(script, disguised)
  files.register(disguised)
  await expect(files.open(disguised)).rejects.toThrow('is not a kind of file this app opens')
  expect(openPath).not.toHaveBeenCalled()
})

test('a folder, a bundle and a file that has gone are refused, in words', async () => {
  const { files } = setup()
  const folder = join(root, 'Reports.pdf')
  await mkdir(folder)
  files.register(folder)
  await expect(files.open(folder)).rejects.toThrow('Reports.pdf is not a file.')
  const bundle = join(root, 'Calculator.app')
  await mkdir(bundle)
  files.register(bundle)
  await expect(files.open(bundle)).rejects.toThrow('is not a kind of file this app opens')
  const gone = join(root, 'gone.pdf')
  files.register(gone)
  await expect(files.open(gone)).rejects.toThrow('gone.pdf is no longer there.')
})

test('the system’s refusal to open a file is the error the card shows', async () => {
  const { files } = setup({ openPath: async () => 'No application knows how to open this file.' })
  const path = await file('data.csv')
  files.register(path)
  await expect(files.open(path)).rejects.toThrow('No application knows how to open this file.')
})

test('a preview of an attached path says what it is, draws its thumbnail and says whether it opens', async () => {
  const { files, createThumbnail } = setup()
  const pdf = await file('report.pdf')
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
  files.register(folder)
  expect(await files.preview(folder)).toEqual({ kind: 'folder', thumbnailDataUrl: null, openable: false })
  const gone = join(root, 'nothing.pdf')
  files.register(gone)
  expect(await files.preview(gone)).toEqual({ kind: 'missing', thumbnailDataUrl: null, openable: false })
})

test('a path nobody attached is answered without the disk: not stat’ed, not drawn, not openable', async () => {
  const { files, createThumbnail } = setup()
  const pdf = await file('report.pdf')
  const folder = join(root, 'Docs')
  await mkdir(folder)
  for (const path of [pdf, folder, join(root, 'nothing.pdf')])
    expect(await files.preview(path), path).toEqual({ kind: 'unknown', thumbnailDataUrl: null, openable: false })
  expect(statCalls, 'nothing a transcript merely names is looked at').toEqual([])
  expect(createThumbnail).not.toHaveBeenCalled()
})

test('on Windows a UNC path a transcript names is never touched: no stat, no thumbnail, no open', async () => {
  const { files, createThumbnail, openPath } = setup({ platform: 'win32' })
  const unc = '\\\\attacker\\share\\x.pdf'
  expect(await files.preview(unc)).toEqual({ kind: 'unknown', thumbnailDataUrl: null, openable: false })
  await expect(files.open(unc)).rejects.toThrow(
    'x.pdf was not attached here, so it can only be shown in File Explorer.',
  )
  expect(statCalls).toEqual([])
  expect(createThumbnail).not.toHaveBeenCalled()
  expect(openPath).not.toHaveBeenCalled()
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

test('a request keeps its place until the system answers it, not until the card stops waiting', async () => {
  vi.useFakeTimers()
  const answers: (() => void)[] = []
  const createThumbnail = vi.fn(
    () => new Promise<ReturnType<typeof image>>((resolve) => answers.push(() => resolve(image('data:,late')))),
  )
  const thumbnails = createAttachedFileThumbnails({ platform: 'darwin', createThumbnail, timeoutMs: 50 })
  const stamp = { size: 1, mtimeMs: 1 }
  const first = Array.from({ length: THUMBNAIL_CONCURRENCY }, (_, index) =>
    thumbnails.thumbnail(`/Users/dev/slow-${index}.key`, stamp),
  )
  await vi.advanceTimersByTimeAsync(50)
  expect(await Promise.all(first), 'the cards settle on their glyphs at the timeout').toEqual([null, null])
  const next = thumbnails.thumbnail('/Users/dev/next.pdf', stamp)
  await vi.advanceTimersByTimeAsync(10)
  expect(createThumbnail, 'the readers still at work hold every place').toHaveBeenCalledTimes(THUMBNAIL_CONCURRENCY)
  answers[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(createThumbnail, 'one answered, so the next starts').toHaveBeenCalledTimes(THUMBNAIL_CONCURRENCY + 1)
  answers[THUMBNAIL_CONCURRENCY]()
  expect(await next).toBe('data:,late')
})

test('a thumbnailer that throws at once gives its place back', async () => {
  const createThumbnail = vi.fn(() => {
    throw new Error('no reader')
  })
  const thumbnails = createAttachedFileThumbnails({ platform: 'win32', createThumbnail })
  for (let index = 0; index < THUMBNAIL_CONCURRENCY + 2; index++)
    expect(await thumbnails.thumbnail(`C:\\Users\\dev\\${index}.pdf`, { size: 1, mtimeMs: 1 })).toBeNull()
  expect(createThumbnail).toHaveBeenCalledTimes(THUMBNAIL_CONCURRENCY + 2)
})

test('Windows hands no network path to the thumbnailer', async () => {
  const createThumbnail = vi.fn(async () => image('data:image/png;base64,AAAA'))
  const windows = createAttachedFileThumbnails({ platform: 'win32', createThumbnail })
  expect(await windows.thumbnail('\\\\fileserver\\team\\plan.pdf', { size: 1, mtimeMs: 1 })).toBeNull()
  expect(await windows.thumbnail('//fileserver/team/plan.pdf', { size: 1, mtimeMs: 1 })).toBeNull()
  expect(createThumbnail).not.toHaveBeenCalled()
  expect(await windows.thumbnail('C:\\Users\\dev\\plan.pdf', { size: 1, mtimeMs: 1 })).toBe(
    'data:image/png;base64,AAAA',
  )
})

test('Linux draws no thumbnails, and a huge file is not handed to the thumbnailer', async () => {
  const createThumbnail = vi.fn(async () => image('data:image/png;base64,AAAA'))
  const linux = createAttachedFileThumbnails({ platform: 'linux', createThumbnail })
  expect(await linux.thumbnail('/home/dev/a.pdf', { size: 1, mtimeMs: 1 })).toBeNull()
  const mac = createAttachedFileThumbnails({ platform: 'darwin', createThumbnail })
  expect(await mac.thumbnail('/Users/dev/movie.mov', { size: MAX_THUMBNAIL_SOURCE_BYTES + 1, mtimeMs: 1 })).toBeNull()
  expect(createThumbnail).not.toHaveBeenCalled()
})
