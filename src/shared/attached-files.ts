// Files attached to a message by path: what both ends of "open it" agree on.
// The composer offers a click that opens an attached file in the app the
// operating system picks for it, and main is what actually opens it. Only a
// file whose kind is known to be shown — a document, a picture, a recording —
// is opened that way; everything else is only revealed in its folder, so both
// ends ask the same question of a path before they offer or do it.

// What a click may open in its default app: documents, plain text and data,
// pictures, sound and video. An allowlist rather than a list of what runs,
// because the list of what a system will run (or mount, or follow somewhere
// else) on a double-click is long, differs by platform and grows: a help file,
// a disk image, a saved search and an add-in all do something other than show
// themselves. A kind missing here costs a click to reveal it; a kind missing
// from a blocklist cost a program run.
//
// Left out on purpose:
// - Office formats that carry macros (docm, xlsm, pptm, …), the older binary
//   ones (doc, xls, ppt), which carry them too without the name saying so,
//   and anything a browser opens as a page (html, svg, xhtml): those run code
//   of their own.
// - Archives and disk images (zip, dmg, iso, …): opening one expands or mounts
//   it, which is more than showing it.
const OPENABLE_EXTENSIONS = new Set([
  // Documents
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'odg',
  'rtf',
  'pages',
  'numbers',
  'key',
  'epub',
  // Plain text and data
  'txt',
  'text',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'log',
  // Pictures
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  // Sound
  'mp3',
  'm4a',
  'wav',
  'aac',
  'flac',
  'ogg',
  'opus',
  'aif',
  'aiff',
  // Video
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
])

/** The extension of a path's last segment, lower-cased, or '' when it has none. */
export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// A Windows name the shell reads differently from how it is spelled: one that
// names a stream (`notes.txt:payload.exe`, or `setup.exe:x.pdf`, which is the
// program's stream and not a PDF), or one ending in a dot or a space, which
// the shell trims before it decides what the file is.
function windowsNameMisleads(name: string): boolean {
  return name.includes(':') || /[. ]$/u.test(name)
}

/**
 * Whether a click may open this file in its default app: only a kind on the
 * allowlist, judged by its name. Anything else — a program, a script, a
 * shortcut, an archive, a file with no extension — is only ever revealed in
 * Finder or Explorer. By name alone; main judges a link by its target too.
 */
export function opensInDefaultApp(path: string, platform: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (platform === 'win32' && windowsNameMisleads(name)) return false
  return OPENABLE_EXTENSIONS.has(fileExtension(name))
}

// The iWork formats are saved either as one file or as a package: a folder the
// Mac shows and opens as a single document. Such a folder opens like the file
// would, on macOS only, where the system knows it as a document; elsewhere it
// is a folder like any other, and only revealed.
const DOCUMENT_PACKAGE_EXTENSIONS = new Set(['pages', 'numbers', 'key'])

/** Whether a folder at this path is a document package a click may open in its default app (macOS only). */
export function opensAsDocumentPackage(path: string, platform: string): boolean {
  return platform === 'darwin' && DOCUMENT_PACKAGE_EXTENSIONS.has(fileExtension(path))
}

/**
 * A path on another machine: a Windows UNC path (`\\server\share\…`, or the
 * same with forward slashes) or a device path (`\\?\…`, `\\.\…`), which may be
 * a UNC path in disguise. Touching one — even to ask whether it exists — has
 * Windows connect to that server and offer it the person's credentials, so a
 * path like this is never looked at unless the person attached it, and is
 * never handed to the thumbnailer at all. Elsewhere a network share is a
 * mounted folder like any other, and nothing in the path says so.
 */
export function isNetworkPath(path: string, platform: string): boolean {
  return platform === 'win32' && /^[\\/]{2}/u.test(path)
}

/** What main answers about an attached file: what to draw, and whether a click may open it. */
export type AttachedFilePreview = {
  /**
   * `missing` when the path names nothing on this disk any more; `unknown` for
   * a path this computer did not attach, which main does not look at.
   */
  kind: 'file' | 'folder' | 'missing' | 'unknown'
  /** The operating system's own picture of the file, as a `data:` URL, when it drew one. */
  thumbnailDataUrl: string | null
  /** A click opens it in its default app; otherwise the only action is to reveal it. */
  openable: boolean
}
