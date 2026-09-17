// Where a board may live inside a project, and how a caller's spelling of a
// board path is turned into the one form the service stores and compares by.
//
// Everything downstream — the board registry, the fs watcher, the tab's "one
// tab per path" rule — keys off the normalized string, so normalization has to
// be total and idempotent: the same board named three ways has to collapse to
// one key, and anything that could escape the workspace root has to be refused
// here rather than at the fs call.

import type { CanvasResult } from './types'
import { canvasFail, canvasOk } from './types'

/** Where a bare board name lands, at the workspace root. */
export const CANVAS_DEFAULT_FOLDER = 'diagrams'

export const CANVAS_FILE_EXTENSION = '.excalidraw'

/**
 * How many boards a listing carries.
 *
 * One number, read by the service (which caps what it returns) and by the tool
 * (which says so when the cap is what the caller is looking at). Two numbers
 * would make "and there may be more" either a lie or impossible to say.
 */
export const CANVAS_LIST_MAX_BOARDS = 200

/** The board a tool targets when the workspace has no recently opened one. */
export const DEFAULT_CANVAS_BOARD_PATH = 'diagrams/canvas.excalidraw'

// Refused wholesale: git's own store, and a dependency tree that is not the
// person's work. A board written into either is either invisible to the project
// or destroyed by the next install. Compared with the case dropped on every
// platform: on two of the three, `.GIT` and `.git` are the same folder, and a
// guard that only catches one spelling is a guard a caller walks around.
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules'])

/**
 * Whether this platform's filesystem reads two spellings of one name as one
 * file. Darwin and Windows do; Linux does not, and there `Arch.excalidraw` and
 * `arch.excalidraw` really are two boards.
 */
export function canvasPathIsCaseInsensitive(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * The key a board is registered and deduplicated under.
 *
 * Two spellings of one path have to collapse to one key wherever the
 * filesystem collapses them to one file — otherwise main holds two board
 * entries, two watchers and two revisions over a single file, and the pane
 * holds two tabs each convinced it owns it. The DISPLAY path keeps whatever
 * spelling it was given; only the key is folded.
 */
export function canvasBoardKeyPath(path: string, platform: string): string {
  return canvasPathIsCaseInsensitive(platform) ? String(path).toLowerCase() : String(path)
}

const NUL = String.fromCharCode(0)

/**
 * Normalize a caller's board path to a posix, project-relative `.excalidraw`
 * path. Accepts a bare name (`arch`), a name with the extension, and any depth
 * of folder. Refuses anything absolute, anything with a drive letter, any `..`
 * segment, any other extension, and the two folders above.
 */
export function normalizeCanvasPath(input: string): CanvasResult<string> {
  if (typeof input !== 'string') return canvasFail('invalid_path', 'A board path must be a string.')
  const raw = input.trim()
  if (!raw) return canvasFail('invalid_path', 'A board path must not be empty.')
  if (raw.includes(NUL)) return canvasFail('invalid_path', 'A board path must not contain a NUL byte.')
  // A Windows caller (or a path pasted out of one) spells the separator the
  // other way; the stored form is posix whatever we were handed.
  const slashed = raw.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(slashed)) {
    return canvasFail('invalid_path', `A board path must be project-relative, not a drive path: ${input}`)
  }
  if (slashed.startsWith('/')) {
    return canvasFail('invalid_path', `A board path must be project-relative, not absolute: ${input}`)
  }

  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    // `a//b` and `a/./b` are the same place as `a/b`, so they normalize rather
    // than fail — `..` cannot, because there is nowhere above the root to go.
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      return canvasFail('invalid_path', `A board path must not climb out of the project: ${input}`)
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      return canvasFail('invalid_path', `A board path must not lead through ${segment}: ${input}`)
    }
    segments.push(segment)
  }
  if (segments.length === 0) return canvasFail('invalid_path', 'A board path must name a file.')

  const last = segments[segments.length - 1]
  // The extension on its own is not a name; without this it would become
  // `.excalidraw.excalidraw` by the dotfile branch below.
  if (last.toLowerCase() === CANVAS_FILE_EXTENSION) return canvasFail('invalid_path', 'A board path must name a file.')
  const dot = last.lastIndexOf('.')
  let fileName: string
  if (dot <= 0) {
    // No extension (or a leading dot, which is a hidden file rather than an
    // extension): the caller gave a name, so we give it the one extension.
    fileName = `${last}${CANVAS_FILE_EXTENSION}`
  } else if (last.slice(dot).toLowerCase() === CANVAS_FILE_EXTENSION) {
    // Accepted however it is spelled, and kept exactly as given: a file already
    // on disk as `Arch.EXCALIDRAW` is that person's file, and normalizing its
    // name here would rename it on the next write.
    fileName = last
  } else {
    return canvasFail('invalid_path', `A board must be a ${CANVAS_FILE_EXTENSION} file: ${input}`)
  }

  const folders = segments.slice(0, -1)
  // A bare name is the common case in a tool call, and the default folder is
  // where the picker looks; a caller who named a folder keeps it.
  const parts = folders.length > 0 ? [...folders, fileName] : [CANVAS_DEFAULT_FOLDER, fileName]
  return canvasOk(parts.join('/'))
}

/** The board's display name: its basename without the extension. */
export function canvasBoardName(path: string): string {
  const slashed = String(path).replace(/\\/g, '/')
  const last = slashed.slice(slashed.lastIndexOf('/') + 1)
  return last.endsWith(CANVAS_FILE_EXTENSION) ? last.slice(0, -CANVAS_FILE_EXTENSION.length) : last
}
