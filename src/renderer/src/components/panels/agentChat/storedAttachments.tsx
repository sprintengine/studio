import { useEffect, useState } from 'react'
import type {
  ConversationAttachmentResult,
  ConversationImageAttachment,
  ConversationStoredImageAttachment,
} from '../../../../../shared/conversation-runtime'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { Skeleton, Tooltip } from '../../ui'
import { FileTypeGlyph } from '../../ui/FileTypeGlyph'
import { useConversationTransport, type ConversationTransport } from './conversationTransport'

// A sent image in a bubble that was replayed rather than sent in this run: the
// transcript names it by its attachment-store reference, and the bytes are read
// back only when the bubble is drawn. Once read it is the same thumbnail a live
// bubble shows, and opens the same way.

// Recently read images by reference. A long transcript scrolls its bubbles in
// and out of the window, and each remount would otherwise read the file again;
// the bound keeps a conversation full of screenshots from holding every one of
// them in memory at once.
const MAX_CACHED = 32
const cache = new Map<string, Promise<ConversationAttachmentResult>>()

function readStored(transport: ConversationTransport, ref: string): Promise<ConversationAttachmentResult> | undefined {
  if (!transport.attachment) return undefined
  const cached = cache.get(ref)
  if (cached) {
    cache.delete(ref)
    cache.set(ref, cached)
    return cached
  }
  const read = transport
    .attachment({ ref })
    .catch((error: unknown): ConversationAttachmentResult => ({ ok: false, message: String(error) }))
  cache.set(ref, read)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  // A failed read is not remembered: the next draw asks again.
  void read.then((result) => {
    if (!result.ok && cache.get(ref) === read) cache.delete(ref)
  })
  return read
}

export function StoredAttachmentThumbnail({
  attachment,
  className,
}: {
  attachment: ConversationStoredImageAttachment
  className: string
}) {
  const transport = useConversationTransport()
  const [state, setState] = useState<ConversationImageAttachment | 'loading' | 'missing'>('loading')
  useEffect(() => {
    let cancelled = false
    setState('loading')
    const read = readStored(transport, attachment.ref)
    if (!read) {
      setState('missing')
      return
    }
    void read.then((result) => {
      if (cancelled) return
      setState(
        result.ok
          ? {
              id: attachment.id,
              mediaType: result.mediaType,
              dataBase64: result.dataBase64,
              byteLength: attachment.byteLength,
              ...(attachment.name ? { name: attachment.name } : {}),
            }
          : 'missing',
      )
    })
    return () => {
      cancelled = true
    }
  }, [transport, attachment.ref, attachment.id, attachment.byteLength, attachment.name])
  if (state === 'loading') return <Skeleton className={`${className} rounded-sm bg-[color:var(--bg-hover)]`} />
  if (state !== 'missing') return <AttachmentThumbnail attachment={state} className={className} />
  // Deleted from the store, or kept on another machine: the bubble still says
  // an image was sent, in the square the thumbnail would have filled.
  const label = attachment.name ?? 'Attached image'
  return (
    <Tooltip content={transport.attachment ? `${label} is no longer available` : `${label} is on the other machine`}>
      <span
        role="img"
        aria-label={`${label}, not available`}
        className={`inline-flex items-center justify-center rounded-sm border border-[color:var(--border-subtle)] text-[color:var(--text-subtle)] ${className}`}
      >
        <FileTypeGlyph kind="image" />
      </span>
    </Tooltip>
  )
}
