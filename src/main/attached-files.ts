/**
 * Files attached to a message by path: which ones the app may open, the
 * operating system's picture of each, and the open itself.
 *
 * A composer shows a file dropped, picked or pasted into it as a card, and a
 * click on the card opens the file in the app the system picks for it. That is
 * `shell.openPath`, which will just as happily start a program, so main opens
 * only what was attached and never what would run:
 *
 * - **Attached.** The preload registers a path when it reads one off a real
 *   `File` the person dropped, picked or pasted (`webUtils.getPathForFile`,
 *   which answers nothing for a `File` a page built itself), so a renderer
 *   cannot name an arbitrary path into the list. The list outlives a restart —
 *   a draft and the transcript both keep their cards — and keeps the most
 *   recently attached few hundred.
 * - **Shown, not run.** A program, an installer, a script or a shortcut is
 *   refused by name (`launchesWhenOpened`), by what it resolves to when it is
 *   a link, and on POSIX by an executable bit on a file with no extension,
 *   which the system would hand to a terminal. Such a file is only revealed.
 *
 * Thumbnails come from `nativeImage.createThumbnailFromPath` — Quick Look on
 * macOS, the shell's thumbnail cache on Windows; Linux has none, and there the
 * card keeps its type glyph. Each is small, bounded in time, skipped for huge
 * files, and cached by path, size and modification time.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { isAbsolute, join } from 'path'

import { fileExtension, launchesWhenOpened, type AttachedFilePreview } from '../shared/attached-files'

const FILE_NAME = 'attached-files.json'
/** Paths remembered across restarts, the most recently attached kept. */
export const MAX_ATTACHED_FILES = 500
/** The edge of the square the system draws a thumbnail into, in device pixels. */
export const THUMBNAIL_SIZE = 128
/** How long a thumbnail may take before the card settles for its glyph. */
export const THUMBNAIL_TIMEOUT_MS = 4_000
/** Past this, a file is not handed to the thumbnailer at all. */
export const MAX_THUMBNAIL_SOURCE_BYTES = 256 * 1024 * 1024
/** Thumbnails kept in memory. */
export const MAX_CACHED_THUMBNAILS = 96
// Quick Look and the Windows shell both start a reader per request; a drop of
// thirty files should not start thirty at once.
const THUMBNAIL_CONCURRENCY = 2
const MAX_PATH_LENGTH = 4096

/** A path as it may come over IPC: absolute, bounded, no control characters. */
export function isAttachablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001f]/u.test(value) &&
    (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
  )
}

export type AttachedFileRegistryDeps = {
  resolveUserDataDir: () => string
  limit?: number
}

/**
 * The paths the person attached, newest last. Read once from disk on first
 * use; written whenever it changes. A store that cannot be read starts empty —
 * the worst that costs is a card from before that opens its folder instead.
 */
export function createAttachedFileRegistry(deps: AttachedFileRegistryDeps) {
  const limit = deps.limit ?? MAX_ATTACHED_FILES
  let paths: Set<string> | null = null

  const filePath = () => join(deps.resolveUserDataDir(), FILE_NAME)

  function load(): Set<string> {
    if (paths) return paths
    paths = new Set()
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
      const list = raw && typeof raw === 'object' ? (raw as { paths?: unknown }).paths : null
      if (Array.isArray(list)) for (const entry of list.slice(-limit)) if (isAttachablePath(entry)) paths.add(entry)
    } catch {
      // Absent or unreadable: nothing attached yet, as far as this run knows.
    }
    return paths
  }

  function save(): void {
    const target = filePath()
    const tmp = `${target}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, `${JSON.stringify({ paths: [...load()] })}\n`, 'utf8')
      renameSync(tmp, target)
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // The temp file may never have been written.
      }
      // Kept in memory for this run; only a restart forgets it.
    }
  }

  return {
    register(path: string): void {
      if (!isAttachablePath(path)) return
      const current = load()
      if ([...current].at(-1) === path) return
      // Re-attaching moves a path to the newest end, so the cap drops the stalest.
      current.delete(path)
      current.add(path)
      while (current.size > limit) current.delete(current.values().next().value as string)
      save()
    },
    has(path: string): boolean {
      return load().has(path)
    },
  }
}

export type AttachedFileRegistry = ReturnType<typeof createAttachedFileRegistry>

/** The slice of Electron's `NativeImage` a thumbnail is read through. */
type ThumbnailImage = { isEmpty(): boolean; toDataURL(): string }

export type AttachedFileThumbnailDeps = {
  platform: NodeJS.Platform
  createThumbnail(path: string, size: { width: number; height: number }): Promise<ThumbnailImage>
  timeoutMs?: number
}

/**
 * Thumbnails by path, size and modification time, least recently used out.
 * A failure is cached as `null` like a success, so a file Quick Look cannot
 * draw is not asked about on every render; a changed file is a new key.
 */
export function createAttachedFileThumbnails(deps: AttachedFileThumbnailDeps) {
  const cache = new Map<string, string | null>()
  const inFlight = new Map<string, Promise<string | null>>()
  const waiting: (() => void)[] = []
  let running = 0
  const supported = deps.platform === 'darwin' || deps.platform === 'win32'

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= THUMBNAIL_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
    running += 1
    try {
      return await work()
    } finally {
      running -= 1
      waiting.shift()?.()
    }
  }

  async function draw(path: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs ?? THUMBNAIL_TIMEOUT_MS)
    })
    try {
      const image = await Promise.race([
        deps.createThumbnail(path, { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }),
        timeout,
      ])
      return image && !image.isEmpty() ? image.toDataURL() : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async thumbnail(path: string, file: { size: number; mtimeMs: number }): Promise<string | null> {
      if (!supported || file.size > MAX_THUMBNAIL_SOURCE_BYTES) return null
      const key = `${path}\0${file.size}\0${file.mtimeMs}`
      if (cache.has(key)) {
        const hit = cache.get(key) ?? null
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }
      const pending = inFlight.get(key)
      if (pending) return pending
      const next = slot(() => draw(path)).then((url) => {
        inFlight.delete(key)
        cache.set(key, url)
        while (cache.size > MAX_CACHED_THUMBNAILS) cache.delete(cache.keys().next().value as string)
        return url
      })
      inFlight.set(key, next)
      return next
    },
  }
}

export type AttachedFileThumbnails = ReturnType<typeof createAttachedFileThumbnails>

export type AttachedFilesDeps = {
  registry: AttachedFileRegistry
  thumbnails: AttachedFileThumbnails
  platform: NodeJS.Platform
  openPath(path: string): Promise<string>
}

// Where a refused file can still be found, in the platform's own words.
function fileManagerName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'File Explorer'
  return 'your file manager'
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

// A POSIX file with no extension and an executable bit is a program to the
// system: opened, it runs in a terminal. With an extension the name decides.
function runsByMode(path: string, mode: number, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && !fileExtension(path) && (mode & 0o111) !== 0
}

export function createAttachedFiles(deps: AttachedFilesDeps) {
  return {
    register(path: unknown): void {
      if (isAttachablePath(path)) deps.registry.register(path)
    },

    async preview(path: unknown): Promise<AttachedFilePreview> {
      const missing: AttachedFilePreview = { kind: 'missing', thumbnailDataUrl: null, openable: false }
      if (!isAttachablePath(path)) return missing
      const info = await stat(path).catch(() => null)
      if (!info) return missing
      if (info.isDirectory()) return { kind: 'folder', thumbnailDataUrl: null, openable: false }
      if (!info.isFile()) return missing
      const attached = deps.registry.has(path)
      return {
        kind: 'file',
        // Only for a file the person attached: the transcript can name any
        // path, and the system's readers are not asked about one it merely names.
        thumbnailDataUrl: attached ? await deps.thumbnails.thumbnail(path, info) : null,
        openable: attached && !launchesWhenOpened(path, deps.platform) && !runsByMode(path, info.mode, deps.platform),
      }
    },

    /** Opens an attached file in its default app; throws, in words, when it may not or did not. */
    async open(path: unknown): Promise<void> {
      if (!isAttachablePath(path)) throw new Error('That is not a file this app can open.')
      const name = fileName(path)
      if (!deps.registry.has(path)) {
        throw new Error(`${name} was not attached here, so it can only be shown in ${fileManagerName(deps.platform)}.`)
      }
      const refuse = () =>
        new Error(`${name} would run as a program, so it is only shown in ${fileManagerName(deps.platform)}.`)
      if (launchesWhenOpened(path, deps.platform)) throw refuse()
      const info = await stat(path).catch(() => null)
      if (!info) throw new Error(`${name} is no longer there.`)
      if (!info.isFile()) throw new Error(`${name} is not a file.`)
      // A link opens what it points at, so that is what is judged.
      const target = await realpath(path).catch(() => path)
      if (launchesWhenOpened(target, deps.platform) || runsByMode(target, info.mode, deps.platform)) throw refuse()
      // `openPath` reports failure by resolving with the message, not by throwing.
      const failure = await deps.openPath(target)
      if (failure) throw new Error(failure)
    },
  }
}

export type AttachedFiles = ReturnType<typeof createAttachedFiles>
