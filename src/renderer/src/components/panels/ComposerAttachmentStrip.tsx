// The images staged on a composer before they are sent, and the two helpers
// that describe them. Shared by the chat composer (AgentChatView) and the
// new-chat launch surface (NewAgentPanel): the launch surface is lazily loaded
// and must not import the whole chat panel for one strip, the same split
// utils/imageFileTransfer already makes for the DataTransfer plumbing.

import { memo } from 'react'

import type { ConversationImageAttachment } from '../../../../shared/conversation-runtime'
import { showToast } from '../../store/toastStore'
// The two button modules directly, not the `../ui` barrel: this strip is on the
// lazily-loaded launch surface's path and should pull in two primitives, not the
// whole kit.
import { IconButton, MediaButton } from '../ui/Buttons'
import { ComposerFileChip } from './agentChat/ComposerFileChip'

// A `data:` URL for rendering an attachment thumbnail. The base64 is already in
// memory, so this avoids an object-URL lifecycle with nothing to revoke.
//
// Built once per attachment and kept while the attachment is: the URL is as
// long as the image's base64, often megabytes, and building it on each render
// copied the whole picture again and made React compare two such strings
// character by character to find nothing had changed. An attachment is never
// edited in place, so its object is the key.
const previewUrls = new WeakMap<ConversationImageAttachment, string>()

export function attachmentPreviewUrl(attachment: ConversationImageAttachment): string {
  let url = previewUrls.get(attachment)
  if (url === undefined) {
    url = `data:${attachment.mediaType};base64,${attachment.dataBase64}`
    previewUrls.set(attachment, url)
  }
  return url
}

export function attachmentCountLabel(count: number): string {
  return count === 1 ? '1 image' : `${count} images`
}

function attachmentImageLabel(attachment: ConversationImageAttachment): string {
  return attachment.name ?? 'Attached image'
}

// Hands the image to the operating system's own viewer. A thumbnail this small
// is a reference, not a look at the picture, and the app has no lightbox worth
// preferring to Preview or Photos — so the click leaves the app rather than
// growing a second-rate viewer inside it. Main writes the bytes to a temp file
// first (fs:open-image-attachment); a failure is reported, never swallowed,
// because nothing else on screen would change to say the click did nothing.
export async function openAttachmentImage(attachment: ConversationImageAttachment): Promise<void> {
  try {
    await window.api.openImageAttachment({
      mediaType: attachment.mediaType,
      dataBase64: attachment.dataBase64,
      name: attachment.name,
    })
  } catch (error) {
    showToast({
      tone: 'error',
      title: 'Could not open that image',
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

// One thumbnail, everywhere an attachment is shown: staged on the composer and
// sent in a bubble. It is a button because it does something — the two surfaces
// only disagree about how big the square is. Memoized: the composer re-renders
// on every keystroke, and a staged picture has not changed.
export const AttachmentThumbnail = memo(function AttachmentThumbnail({
  attachment,
  className,
}: {
  attachment: ConversationImageAttachment
  className: string
}) {
  const label = attachmentImageLabel(attachment)
  return (
    <MediaButton
      onClick={() => void openAttachmentImage(attachment)}
      aria-label={`Open ${label}`}
      className={className}
    >
      <img src={attachmentPreviewUrl(attachment)} alt={label} className="h-full w-full object-cover" />
    </MediaButton>
  )
})

// Images staged for the next turn, inside the composer surface above the text
// field so the message reads as one thing. The remove control is a trailing
// action revealed on hover or keyboard focus — the thumbnail is the content,
// not a card of chrome. Files attached by path follow the images as cards
// (ComposerFileChip): the agent receives their paths, the person sees the
// files. Renders nothing when there is nothing staged.
export function ComposerAttachmentStrip({
  attachments,
  reading,
  onRemove,
  files = [],
  onRemoveFile,
  className = 'px-3 pt-2.5',
}: {
  attachments: ConversationImageAttachment[]
  reading: number
  onRemove: (id: string) => void
  /** Files attached by path, in the order they were added. */
  files?: readonly string[]
  onRemoveFile?: (path: string) => void
  // The strip's inset, owned by the surface that mounts it: the chat composer
  // sits it above a padded field, the launch surface inside a padded box.
  className?: string
}) {
  if (attachments.length === 0 && files.length === 0 && reading === 0) return null
  return (
    <ul className={`flex flex-wrap items-center gap-2 ${className}`}>
      {attachments.map((attachment) => (
        <li key={attachment.id} className="relative">
          <AttachmentThumbnail attachment={attachment} className="h-12 w-12" />
          {/* The kit's `3xs` step pads its hit target out to the floor with a
              centred pseudo-element, which makes the control `relative`; the
              placement therefore belongs to this wrapper rather than to the
              button. The resting ground is the caller's because `IconButton`
              declares none at rest, and a bare cross over a photograph is not
              legible. */}
          <span className="absolute right-1 top-1">
            <IconButton
              size="3xs"
              aria-label={`Remove ${attachment.name ?? 'attached image'}`}
              onClick={() => onRemove(attachment.id)}
              className="bg-[color:var(--bg-surface-raised)]/85"
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </IconButton>
          </span>
        </li>
      ))}
      {files.map((path) => (
        <li key={`file:${path}`}>
          <ComposerFileChip path={path} onRemove={onRemoveFile} />
        </li>
      ))}
      {reading > 0 ? (
        <li className="text-meta leading-5 text-[color:var(--text-muted)]">Reading {attachmentCountLabel(reading)}…</li>
      ) : null}
    </ul>
  )
}
