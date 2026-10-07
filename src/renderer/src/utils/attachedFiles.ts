import { fileTypeKind, type FileTypeKind } from '../components/ui/FileTypeGlyph'
import { quotePromptPath } from './imageFileTransfer'

// Files attached to a message by path. The composer holds each as a card, and
// the agent receives each as its path: an agent reads a PDF or a spreadsheet
// off the disk itself, so the path is the attachment. The paths go after the
// words, in a paragraph of their own, quoted the way a drop onto a terminal
// quotes them — which is what lets a sent bubble draw that paragraph as the
// same cards again, without the transcript carrying anything new.

/** The message as the agent receives it: the words, then the paths in a paragraph of their own. */
export function composeMessageWithFiles(text: string, paths: readonly string[]): string {
  const list = paths.map(quotePromptPath).join(' ')
  if (!list) return text
  return text ? `${text}\n\n${list}` : list
}

// An absolute path on this machine, and more than a word after a slash: a
// message that is only `/review` is a command, not a file at the root.
function isAttachedPathWord(word: string): boolean {
  if (/^[A-Za-z]:[\\/]./.test(word) || /^\\\\[^\\]+\\./.test(word)) return true
  return /^\/[^/]+\/./.test(word)
}

// The words of a paths paragraph, read the way `quotePromptPath` writes them:
// bare, "double-quoted" (a Windows path, backslashes and all), or 'single-
// quoted' with an apostrophe spliced in as '"'"'. A shell's own reading would
// take a Windows path's backslashes for escapes.
const QUOTED_PATH = /"[^"]*"|'[^']*'(?:"'"'[^']*')*|[^\s'"]+/g

function unquotePath(word: string): string {
  if (word.startsWith('"')) return word.slice(1, -1)
  if (word.startsWith("'")) return word.slice(1, -1).replace(/'"'"'/g, "'")
  return word
}

/**
 * A sent message split back into its words and the files attached to it: the
 * last paragraph, when it is nothing but paths spelled exactly as
 * `composeMessageWithFiles` spells them. Anything else is words, whole.
 */
export function splitAttachedFiles(message: string): { text: string; paths: string[] } {
  const whole = { text: message, paths: [] }
  const trimmed = message.replace(/\s+$/u, '')
  const cut = trimmed.lastIndexOf('\n\n')
  const tail = cut < 0 ? trimmed : trimmed.slice(cut + 2)
  if (!tail || tail.includes('\n')) return whole
  const words = (tail.match(QUOTED_PATH) ?? []).map(unquotePath)
  if (!words.length || !words.every(isAttachedPathWord)) return whole
  if (words.map(quotePromptPath).join(' ') !== tail) return whole
  return { text: cut < 0 ? '' : trimmed.slice(0, cut).replace(/\s+$/u, ''), paths: words }
}

// The extension a file with none in its name is drawn as, by the media type
// the browser reports for it.
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/rtf': 'rtf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * What a card says a file is: its glyph's kind and a short type label — the
 * extension as people say it (PDF, DOCX, XLSX), or `File` when the name has
 * none worth showing. By name first; the media type answers for a name with no
 * extension.
 */
export function attachedFileType(name: string, mediaType = ''): { kind: FileTypeKind; label: string } {
  const base = name.split(/[\\/]/).pop() ?? name
  const named = extensionOf(base)
  const extension = named || MEDIA_TYPE_EXTENSIONS[mediaType.toLowerCase()] || ''
  const kind = fileTypeKind(named ? base : extension ? `file.${extension}` : base)
  return { kind, label: /^[a-z0-9]{1,5}$/.test(extension) ? extension.toUpperCase() : 'File' }
}

/**
 * A file name cut in the middle to at most `max` characters, keeping its
 * start and its extension: "Quarterly report final v3.pdf" keeps both the
 * words that say which report and the `.pdf` that says what it is.
 */
export function middleTruncateFileName(name: string, max: number): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const stem = name.slice(0, name.length - extension.length)
  const room = max - 1 - extension.length
  if (room < 4) return `${name.slice(0, Math.max(1, max - 1))}…`
  const head = Math.ceil(room * 0.6)
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (room - head))}${extension}`
}

/** The last segment of a path, whichever separator it uses. */
export function attachedFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
