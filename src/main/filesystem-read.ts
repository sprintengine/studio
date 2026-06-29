import { shell } from 'electron'
import { access, lstat, readdir, readFile, realpath, stat } from 'fs/promises'
import { extname, sep } from 'path'
import { pathToFileURL } from 'url'
import { normalizeReportPath } from '../shared/automations/contracts'
import { imageMimeType } from './filesystem-image'
import {
  MAX_IMAGE_DATA_URL_BYTES,
  MAX_TEXT_FILE_READ_BYTES,
} from './filesystem-read-limits'
import { checkWorkspaceFolder, pathExists } from './filesystem-workspace'

const BINARY_SNIFF_BYTES = 4096
const MAX_CONTROL_CHARACTER_RATIO = 0.05

export {
  MAX_IMAGE_DATA_URL_BYTES,
  MAX_TEXT_FILE_READ_BYTES,
}

export function createFilesystemReadHandlers() {
  return {
    async readDirectory(dirPath: string) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    },
    async readTextFile(filePath: string) {
      await assertReportSymlinkContained(filePath)
      const targetStats = await stat(filePath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be read.')
      }
      if (targetStats.size > MAX_TEXT_FILE_READ_BYTES) {
        throw new Error(
          `File is too large to open in Multicode (${formatBytes(targetStats.size)}; limit ${formatBytes(MAX_TEXT_FILE_READ_BYTES)}).`
        )
      }

      const content = await readFile(filePath)
      if (looksLikeBinary(content)) {
        throw new Error('File appears to be binary and cannot be opened as text.')
      }

      return content.toString('utf-8')
    },
    async readImageDataUrl(filePath: string) {
      const mimeType = imageMimeType(filePath)
      if (!mimeType) throw new Error('Unsupported image file type.')
      const targetStats = await stat(filePath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be read.')
      }
      if (targetStats.size > MAX_IMAGE_DATA_URL_BYTES) {
        throw new Error(
          `Image is too large to preview in Multicode (${formatBytes(targetStats.size)}; limit ${formatBytes(MAX_IMAGE_DATA_URL_BYTES)}).`
        )
      }
      const content = await readFile(filePath)
      return `data:${mimeType};base64,${content.toString('base64')}`
    },
    async statPath(targetPath: string) {
      const targetStats = await stat(targetPath)
      return {
        isFile: targetStats.isFile(),
        isDirectory: targetStats.isDirectory(),
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtime.toISOString(),
        modifiedAtMs: targetStats.mtimeMs,
      }
    },
    pathExists,
    checkWorkspaceFolder,
    async showItemInFolder(targetPath: string) {
      await access(targetPath)
      shell.showItemInFolder(targetPath)
    },
    async openHtmlFileInBrowser(targetPath: string) {
      const extension = extname(targetPath).toLowerCase()
      if (extension !== '.html' && extension !== '.htm') {
        throw new Error('Only HTML files can be opened in the browser.')
      }

      const targetStats = await stat(targetPath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be opened in the browser.')
      }

      await shell.openExternal(pathToFileURL(targetPath).toString())
    },
  }
}

// Defense-in-depth for the automation report read path. The renderer already
// runs the string containment guard (normalizeReportPath) before asking to read
// a `reports/` file, but that guard inspects the path text only — a committed
// git symlink `reports/leak.md -> ../../../secret` (mode 120000) is a clean,
// contained string yet resolves out of `reports/`. We re-run the string guard
// here as the first check, then realpath the target and confirm a symlinked
// report stays under its `reports/` root; an escape throws, which the viewer
// surfaces as not-found rather than the target file's contents.
//
// Scope is deliberately narrow: only a path that lives under a `reports/`
// ancestor and is itself a symlink is checked, so ordinary file reads (the
// common case) keep their existing behavior and cost.
export async function assertReportSymlinkContained(filePath: string): Promise<void> {
  const boundary = reportsBoundary(filePath)
  if (!boundary) return
  if (normalizeReportPath(boundary.relativePath) === null) {
    throw new Error('Report path is not contained under reports/ and cannot be opened.')
  }

  const linkStats = await lstat(filePath)
  if (!linkStats.isSymbolicLink()) return

  const realRoot = await realpath(boundary.reportsRoot)
  const realTarget = await realpath(filePath)
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error('Report file resolves outside reports/ and cannot be opened.')
  }
}

// Locate the nearest ancestor directory named `reports` for an absolute report
// path. Returns that directory (the containment root) and the project-relative
// `reports/<rest>` text for the string guard, or null when the path is not a
// report read. Nearest-ancestor handling keeps the boundary correct even when
// the workspace root itself contains a `reports/` segment.
function reportsBoundary(filePath: string): { reportsRoot: string; relativePath: string } | null {
  // The resolved report path can carry mixed separators (the renderer joins a
  // native-separator workspace root with a forward-slash report path), so split
  // on both. The reconstructed root is rejoined with the native separator for
  // realpath comparison.
  const segments = filePath.split(/[\\/]/u)
  // The file itself is the last segment; its directory chain is everything
  // before it, so only search ancestor positions.
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] === 'reports') {
      return {
        reportsRoot: segments.slice(0, index + 1).join(sep),
        relativePath: segments.slice(index).join('/'),
      }
    }
  }
  return null
}

export function looksLikeBinary(content: Buffer): boolean {
  if (content.length === 0) return false
  const sample = content.subarray(0, Math.min(content.length, BINARY_SNIFF_BYTES))
  let controlCharacters = 0

  for (const byte of sample) {
    if (byte === 0) return true
    const isAllowedControl =
      byte === 0x09
      || byte === 0x0a
      || byte === 0x0d
      || byte === 0x1b
    if (byte < 0x20 && !isAllowedControl) controlCharacters += 1
  }

  return controlCharacters / sample.length > MAX_CONTROL_CHARACTER_RATIO
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
