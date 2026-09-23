// What the Export action says and sends, decided without a DOM or the editor.
//
// Export is how a board reaches the repository now that boards live in the
// app's own store: the person picks a folder and gets the board file there, and
// a picture of it beside the file when they ask for one. The editor renders the
// pictures (it is the only thing holding the library), the tab owns the dialog,
// and main shows the folder picker and writes the files. What is left here is
// the vocabulary those three share and the sentences the dialog and the toast
// say, which is the part worth proving on its own.

import { CANVAS_FILE_EXTENSION } from '../../../../../../shared/canvas/paths'
import type { CanvasExportImages } from '../../../../../../shared/canvas/types'

/** The pictures the person asked for beside the board file. */
export type CanvasExportFormats = { png: boolean; svg: boolean }

/** Nothing extra by default: the board file is what goes into the repository. */
export const CANVAS_EXPORT_DEFAULT_FORMATS: CanvasExportFormats = { png: false, svg: false }

/**
 * The editor's half of an export: bring main up to date with what is on
 * screen, then render the pictures asked for. Handed up to the tab by the
 * editor, so the tab can run the dialog without importing the library.
 */
export type CanvasBoardExporter = (formats: CanvasExportFormats) => Promise<CanvasExportImages>

/** The files an export writes, in the order it writes them. */
export function canvasExportFileNames(name: string, formats: CanvasExportFormats): string[] {
  const files = [`${name}${CANVAS_FILE_EXTENSION}`]
  if (formats.png) files.push(`${name}.png`)
  if (formats.svg) files.push(`${name}.svg`)
  return files
}

/** The basename of a path main answered with, whichever separator it used. */
function baseName(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return slashed.slice(slashed.lastIndexOf('/') + 1)
}

/**
 * The toast an export that landed says: what was written, and where. The
 * folder is said in full because it is the one thing the person chose and may
 * want to check; the files by name, because they sit side by side in it.
 */
export function canvasExportedToast(result: { directory: string; files: readonly string[] }): {
  title: string
  description: string
} {
  const names = result.files.map(baseName)
  return {
    title:
      names.length === 1
        ? 'Board exported'
        : `Board exported with ${names.length - 1} image${names.length === 2 ? '' : 's'}`,
    description: `${names.join(', ')} in ${result.directory}`,
  }
}
