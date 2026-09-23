// The real filesystem behind the canvas service's facade.
//
// It is a separate file for one reason: `canvas-service.ts` takes the facade as
// a dependency so its tests can hand it a map in memory, and the moment the
// service imported `node:fs` directly that would stop being true for anyone who
// forgot to pass one. Here there is nothing to test — every function is one
// call through to Node.

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'

import type { CanvasDirectoryWatcher, CanvasFs } from './canvas-service'

export function createNodeCanvasFs(): CanvasFs {
  return {
    readFile: (path) => readFile(path, 'utf-8'),
    writeFile: (path, contents) => writeFile(path, contents, 'utf-8'),
    writeBytes: (path, contents) => writeFile(path, contents),
    rename: (from, to) => rename(from, to),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    stat: async (path) => {
      const stats = await stat(path)
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      }
    },
    readdir: async (path) => {
      const entries = await readdir(path, { withFileTypes: true })
      // A symlink is neither, deliberately: the walk does not follow one out of
      // the project, and containment here is about the path we were handed.
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }))
    },
    unlink: (path) => unlink(path),
  }
}

/**
 * Watch a board's folder. Non-recursive on purpose: one board's directory is
 * all the service asked for, and `recursive: true` costs a whole subtree on
 * platforms that emulate it.
 */
export function watchCanvasDirectory(
  directory: string,
  onChange: (filename: string | null) => void,
): CanvasDirectoryWatcher {
  const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
    onChange(typeof filename === 'string' ? filename : null)
  })
  // A watcher that errors (the folder was removed under it) goes quiet rather
  // than taking the process down with an unhandled 'error' event.
  watcher.on('error', () => {
    watcher.close()
  })
  return { close: () => watcher.close() }
}
