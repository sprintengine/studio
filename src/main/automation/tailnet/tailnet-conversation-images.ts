import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'

import { inferConversationToolKind } from '../../../shared/conversation/toolKind'
import {
  distroOfUncPath,
  isWslDriveMountPath,
  wslPathInRootSpelling,
  wslToWindowsPath,
} from '../../../shared/host-paths'
import { MAX_IMAGE_DATA_URL_BYTES } from '../../filesystem-read-limits'

// The pictures a chat shows under its steps — one Codex generated, one an
// agent looked at — served to a paired device by the tool call's id.
//
// The file is always named by the conversation's own record of the step, never
// by the asker: a device says which step, and this machine says where that
// step's picture is. What is served is decided by the file's first bytes, not
// its name, so a step that "read" `notes.png` full of text serves nothing.

/**
 * The largest picture served. The same ceiling this machine's own chat previews
 * under (`readImageDataUrl`), so a paired device is shown what this desktop
 * would show, and refused what it would refuse. Not the attachment cap: that
 * one is the vision API's limit on what a turn may carry, and a picture an
 * agent made or read is not being sent to a model.
 */
export const CONVERSATION_IMAGE_MAX_BYTES = MAX_IMAGE_DATA_URL_BYTES

export type ConversationImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Bytes enough to tell the four formats apart. */
const SNIFF_BYTES = 12

/**
 * What the first bytes of a file say it is, among the four formats every
 * client of this route can draw. Anything else — an SVG (a document, and a
 * script host), a BMP, a text file wearing `.png` — is not served.
 */
export function sniffConversationImage(head: Uint8Array): ConversationImageMediaType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end))
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

// A path a chat previews as a picture (the renderer's `previewsAsImage`). The
// name only decides whether a read is a picture read at all; the bytes decide
// what is served.
const IMAGE_PATH = /\.(apng|avif|bmp|gif|ico|jpe?g|png|webp)$/iu

/**
 * The file a recorded tool call shows as a picture, or null when it shows
 * none: `GenerateImage` (where Codex saved what it made), or a file read whose
 * path is a picture. The path is read from the step's input under the keys the
 * presentation reads it by.
 */
export function conversationImagePathOf(tool: { name: string; kind: unknown; input: unknown }): string | null {
  const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : {}
  const values = input as Record<string, unknown>
  const path = [values.path, values.file_path, values.filePath].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (!path) return null
  if (tool.name === 'GenerateImage') return path
  const kind = typeof tool.kind === 'string' && tool.kind ? tool.kind : inferConversationToolKind(tool.name)
  return kind === 'file_read' && IMAGE_PATH.test(path.trim()) ? path : null
}

/**
 * A picture's path as this machine opens it. A chat run in WSL records Linux
 * paths (`/mnt/c/…`, `/home/…`), which Windows cannot open as they are: a
 * drive mount becomes its drive, and a path inside the distribution its share,
 * spelled as the chat's folder is (`\\wsl$\…` stays `\\wsl$\…`). A path
 * inside a distribution the folder does not name is left as it is.
 */
export function conversationImageFileOf(
  path: string,
  workspaceRoot: string,
  platform: string = process.platform,
): string {
  if (platform !== 'win32' || !path.startsWith('/') || path.startsWith('//')) return path
  const distro = distroOfUncPath(workspaceRoot)
  if (distro) return wslPathInRootSpelling(path, workspaceRoot, distro)
  return isWslDriveMountPath(path) ? wslToWindowsPath(path) : path
}

export type ConversationImageRefusal = {
  status: 404 | 413 | 415
  code: 'unknown_image' | 'image_too_large' | 'not_an_image'
  message: string
}

export type OpenedConversationImage = {
  /** Open for reading; the caller closes it, or streams it with `autoClose`. */
  file: FileHandle
  size: number
  mediaType: ConversationImageMediaType
}

const gone = (): ConversationImageRefusal => ({
  status: 404,
  code: 'unknown_image',
  message: 'That picture is no longer on this machine.',
})

/**
 * Open the picture at a path a transcript recorded, ready to stream.
 *
 * The path came from the conversation's own record, so it is not an asker's
 * choice, but it is still a path an agent wrote: a link is followed to what it
 * names and that is checked instead, and only a regular file is opened — a
 * device node or a pipe is refused before it is touched, and the descriptor is
 * checked again once it is open, so a file swapped in between is not what gets
 * read.
 */
export async function openConversationImage(
  path: string,
  maxBytes = CONVERSATION_IMAGE_MAX_BYTES,
): Promise<{ ok: true; image: OpenedConversationImage } | { ok: false; refusal: ConversationImageRefusal }> {
  let target: string
  let before: Awaited<ReturnType<typeof stat>>
  try {
    target = await realpath(path)
    before = await stat(target)
  } catch {
    return { ok: false, refusal: gone() }
  }
  if (!before.isFile()) return { ok: false, refusal: gone() }
  if (before.size > maxBytes) return { ok: false, refusal: tooLarge(maxBytes) }
  let file: FileHandle
  try {
    // No-follow on a path already resolved: a link put in its place since is
    // refused rather than followed. Non-blocking so nothing can hold the open.
    file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return { ok: false, refusal: gone() }
  }
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      await file.close()
      return { ok: false, refusal: gone() }
    }
    if (opened.size > maxBytes) {
      await file.close()
      return { ok: false, refusal: tooLarge(maxBytes) }
    }
    const head = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await file.read(head, 0, SNIFF_BYTES, 0)
    const mediaType = sniffConversationImage(head.subarray(0, bytesRead))
    if (!mediaType) {
      await file.close()
      return {
        ok: false,
        refusal: { status: 415, code: 'not_an_image', message: 'That file is not a PNG, JPEG, WebP or GIF picture.' },
      }
    }
    return { ok: true, image: { file, size: opened.size, mediaType } }
  } catch {
    await file.close().catch(() => undefined)
    return { ok: false, refusal: gone() }
  }
}

function tooLarge(maxBytes: number): ConversationImageRefusal {
  return {
    status: 413,
    code: 'image_too_large',
    message: `That picture is over the ${Math.floor(maxBytes / (1024 * 1024))}MB this machine serves.`,
  }
}
