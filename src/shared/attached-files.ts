// Files attached to a message by path: what both ends of "open it" agree on.
// The composer offers a click that opens an attached file in the app the
// operating system picks for it, and main is what actually opens it. A file the
// system would RUN rather than show is never opened that way — only revealed —
// so both ends ask the same question of a path before they offer or do it.

// What opening runs instead of shows, on every platform: programs and their
// installers, scripts a double-click executes, and the shortcut and location
// files that point somewhere else entirely (a `.fileloc` or a `.lnk` can name
// an app). A macOS bundle (`.app`, `.pkg`) is a folder and refused as one too,
// but its name says it first.
const LAUNCHING_EXTENSIONS = new Set([
  'app',
  'appex',
  'action',
  'workflow',
  'prefpane',
  'bundle',
  'plugin',
  'kext',
  'xpc',
  'pkg',
  'mpkg',
  'command',
  'tool',
  'terminal',
  'fileloc',
  'inetloc',
  'webloc',
  'sh',
  'bash',
  'zsh',
  'csh',
  'ksh',
  'fish',
  'py',
  'pyw',
  'pyz',
  'pl',
  'rb',
  'jar',
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'msix',
  'msp',
  'appx',
  'scr',
  'pif',
  'cpl',
  'msc',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'hta',
  'reg',
  'inf',
  'scf',
  'lnk',
  'url',
  'application',
  'appref-ms',
  'gadget',
  'desktop',
  'appimage',
  'run',
  'deb',
  'rpm',
])

// Script files Windows hands to its script host on a double-click, which runs
// them. Elsewhere the same names open in an editor, so they are refused only
// there.
const WINDOWS_LAUNCHING_EXTENSIONS = new Set(['js', 'jse'])

/** The extension of a path's last segment, lower-cased, or '' when it has none. */
export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Whether opening this file in its default app would run it. Such a file is
 * only ever revealed in Finder or Explorer: a click on a chip must never start
 * a program, whatever the file calls itself. By name alone — main also refuses
 * a POSIX file with no extension and an executable bit, which the name cannot
 * show.
 */
export function launchesWhenOpened(path: string, platform: string): boolean {
  const extension = fileExtension(path)
  if (!extension) return false
  if (LAUNCHING_EXTENSIONS.has(extension)) return true
  return platform === 'win32' && WINDOWS_LAUNCHING_EXTENSIONS.has(extension)
}

/** What main answers about an attached file: what to draw, and whether a click may open it. */
export type AttachedFilePreview = {
  /** `missing` when the path names nothing on this disk any more. */
  kind: 'file' | 'folder' | 'missing'
  /** The operating system's own picture of the file, as a `data:` URL, when it drew one. */
  thumbnailDataUrl: string | null
  /** A click opens it in its default app; otherwise the only action is to reveal it. */
  openable: boolean
}
