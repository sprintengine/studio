import { createHash } from 'node:crypto'
import { nativeImage } from 'electron'

import type { PeekImagePayload } from './transcript'

/**
 * Make the small picture the peek card draws, and keep it.
 *
 * The transcript carries pasted screenshots as base64 at full resolution — the
 * three on one real first message measured 505KB, 657KB and 303KB — and the IPC
 * payload for a hover cannot carry that. So the bytes are decoded once, resized
 * to a chip, re-encoded as PNG and handed over as a `data:` URL, exactly the
 * decode-and-resize the project logos already use (`project-logo-io.ts`).
 *
 * The cache is keyed by a digest of the base64 rather than by the attachment id
 * because the same screenshot pasted into two chats is the same picture, and
 * because an attachment id is only stable for as long as its transcript row is.
 */

/**
 * Longest edge of the thumbnail. The card draws it around 46×34 CSS px, so this
 * is roughly 2× for a retina panel and no more — a bigger source buys nothing
 * on screen and costs the IPC payload.
 */
export const PEEK_THUMBNAIL_MAX_PX = 128

/**
 * Thumbnails kept in memory. Each is a few KB of PNG, so the ceiling is tens of
 * KB, and the working set is "the chats a person hovered recently".
 */
const THUMBNAIL_CACHE_ENTRIES = 96

const cache = new Map<string, string | null>()

/**
 * A small PNG `data:` URL for `image`, or null when the bytes are not an image
 * this machine can decode (`nativeImage` returns an empty image for a format it
 * does not know, and for the truncated base64 a half-written transcript row can
 * carry). Null is a state the card already renders — the chip falls back to its
 * label — so decoding failure is never surfaced as an error.
 */
export function peekImageThumbnail(image: PeekImagePayload): string | null {
  const key = createHash('sha1').update(image.data).digest('hex')
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const thumbnail = renderThumbnail(image)
  cache.set(key, thumbnail)
  while (cache.size > THUMBNAIL_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return thumbnail
}

function renderThumbnail(image: PeekImagePayload): string | null {
  try {
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
    if (decoded.isEmpty()) return null
    const { width, height } = decoded.getSize()
    if (width <= 0 || height <= 0) return null
    // Constrain the longest edge only, so a tall screenshot stays tall — the
    // card crops it in CSS, and squashing it here would misrepresent what was
    // attached.
    const resized = width <= PEEK_THUMBNAIL_MAX_PX && height <= PEEK_THUMBNAIL_MAX_PX
      ? decoded
      : width >= height
        ? decoded.resize({ width: PEEK_THUMBNAIL_MAX_PX, quality: 'good' })
        : decoded.resize({ height: PEEK_THUMBNAIL_MAX_PX, quality: 'good' })
    const png = resized.toPNG()
    if (png.byteLength === 0) return null
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return null
  }
}
