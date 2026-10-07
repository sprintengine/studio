import { fileTypeKind, type FileTypeKind } from '../components/ui/FileTypeGlyph'
import type { ConversationAttachedFile } from '../../../shared/conversation/attachedFiles'
import { LOCAL_HOST_ID } from '../../../shared/execution-host'

export { attachedFileName } from '../../../shared/conversation/attachedFiles'

// Files attached to a message by path. The composer holds each as a card, the
// send carries them as a list beside the words (`files`), and the bubble draws
// that list as the same cards: the agent reads a PDF or a spreadsheet off the
// disk itself, so the path is the attachment, but it is never spelled into the
// person's words, and nothing is read back out of them.

/** A draft's file cards, as the send carries them. */
export function attachedFilesOf(paths: readonly string[]): ConversationAttachedFile[] {
  return paths.map((path) => ({ path }))
}

/**
 * Whether a chat's workspace runs on this computer, so a file attached from
 * this computer's disk is one its agent can read by that path. A chat on an
 * SSH machine, a WSL distribution or a paired machine cannot, and there a file
 * is typed as its path, as it always was.
 */
export function workspaceRunsHere(
  workspace: { hostId?: string | null; environment?: unknown; remoteOrigin?: unknown } | null | undefined,
): boolean {
  if (!workspace) return true
  return !workspace.environment && !workspace.remoteOrigin && (workspace.hostId ?? LOCAL_HOST_ID) === LOCAL_HOST_ID
}

/** A sent message's files, as a draft's cards again (edit from here, fork, retry). */
export function attachedFilePaths(files: readonly ConversationAttachedFile[] | undefined): string[] {
  return (files ?? []).map((file) => file.path)
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
