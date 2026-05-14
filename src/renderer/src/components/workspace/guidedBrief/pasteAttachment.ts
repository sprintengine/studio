import { joinWorkspacePath } from './paths'

export type GuidedBriefAttachment = {
  id: string
  absolutePath: string
  relativePath: string
  filename: string
  mimeType: string
  size: number
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

const INSPIRATION_RELATIVE_PATH_PREFIX = '.guided-brief/inspiration'

export function clipboardImageFromEvent(event: React.ClipboardEvent<HTMLElement>): File | null {
  const items = Array.from(event.clipboardData?.items ?? [])
  for (const item of items) {
    if (item.kind !== 'file') continue
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned an unexpected result type.'))
        return
      }
      const commaIndex = result.indexOf(',')
      if (commaIndex < 0) {
        reject(new Error('FileReader result is not a data URL.'))
        return
      }
      resolve(result.slice(commaIndex + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error.'))
    reader.readAsDataURL(file)
  })
}

function shortRandom(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(4)
    cryptoApi.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(36).slice(2, 10)
}

function timestampSegment(date: Date): string {
  // ISO without milliseconds, colons turned into dashes so the value is a
  // legal cross-platform filename.
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
}

function extensionForMime(mime: string): string {
  if (MIME_EXTENSION[mime]) return MIME_EXTENSION[mime]
  if (mime.startsWith('image/')) {
    const tail = mime.slice('image/'.length)
    if (/^[a-z0-9]+$/.test(tail)) return tail
  }
  return 'bin'
}

export function buildPastedImageDescriptor({
  workspaceRoot,
  inspirationDirectoryPath,
  file,
  now = new Date(),
}: {
  workspaceRoot: string
  inspirationDirectoryPath: string
  file: File
  now?: Date
}): GuidedBriefAttachment {
  const extension = extensionForMime(file.type || 'image/png')
  const filename = `${timestampSegment(now)}-${shortRandom()}.${extension}`
  const absolutePath = joinWorkspacePath(inspirationDirectoryPath, filename)
  const relativePath = `${INSPIRATION_RELATIVE_PATH_PREFIX}/${filename}`
  // joinWorkspacePath here is used only to verify the workspace context;
  // the project-relative reference is the canonical form we send to the agent.
  void workspaceRoot
  return {
    id: filename,
    absolutePath,
    relativePath,
    filename,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  }
}
