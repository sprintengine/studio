// The images staged on a composer before they are sent, and the two helpers
// that describe them. Shared by the chat composer (AgentChatView) and the
// new-chat launch surface (NewAgentPanel): the launch surface is lazily loaded
// and must not import the whole chat panel for one strip, the same split
// utils/imageFileTransfer already makes for the DataTransfer plumbing.

import type { ConversationImageAttachment } from '../../../../shared/conversation-runtime'

// A `data:` URL for rendering an attachment thumbnail. The base64 is already in
// memory, so this avoids an object-URL lifecycle with nothing to revoke.
export function attachmentPreviewUrl(attachment: ConversationImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`
}

export function attachmentCountLabel(count: number): string {
  return count === 1 ? '1 image' : `${count} images`
}

// Images staged for the next turn, inside the composer surface above the text
// field so the message reads as one thing. The remove control is a trailing
// action revealed on hover or keyboard focus — the thumbnail is the content,
// not a card of chrome. Renders nothing when there is nothing staged.
export function ComposerAttachmentStrip({
  attachments,
  reading,
  onRemove,
  className = 'px-3 pt-2.5',
}: {
  attachments: ConversationImageAttachment[]
  reading: number
  onRemove: (id: string) => void
  // The strip's inset, owned by the surface that mounts it: the chat composer
  // sits it above a padded field, the launch surface inside a padded box.
  className?: string
}) {
  if (attachments.length === 0 && reading === 0) return null
  return (
    <ul className={`flex flex-wrap items-center gap-2 ${className}`}>
      {attachments.map((attachment) => (
        <li key={attachment.id} className="relative">
          <img
            src={attachmentPreviewUrl(attachment)}
            alt={attachment.name ?? 'Attached image'}
            className="h-12 w-12 rounded-md border border-[color:var(--border-subtle)] object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${attachment.name ?? 'attached image'}`}
            onClick={() => onRemove(attachment.id)}
            className="interactive absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-md bg-[color:var(--bg-surface-raised)]/85 text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </li>
      ))}
      {reading > 0 ? (
        <li className="text-meta leading-5 text-[color:var(--text-muted)]">
          Reading {attachmentCountLabel(reading)}…
        </li>
      ) : null}
    </ul>
  )
}
