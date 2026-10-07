import React from 'react'
import { CloseIconButton, MediaButton } from './Buttons'
import { TruncatedText } from './TruncatedText'

/** Shared staged-context shape for the launcher and conversation composer. */
export function AttachmentChip({
  glyph,
  label,
  removeLabel,
  onRemove,
  children,
}: {
  glyph?: React.ReactNode
  label: string
  removeLabel: string
  onRemove: () => void
  /** An inspectable label may replace the static text; removal stays separate. */
  children?: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--bg-selected)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
      {glyph}
      {children ?? <TruncatedText as="span" text={label} className="max-w-[140px]" />}
      <CloseIconButton onClick={onRemove} aria-label={removeLabel} className="-mr-1" />
    </span>
  )
}

/**
 * A file attached by path, as a card (attachment-chip → File card): the
 * preview square — a thumbnail, or a glyph until one arrives — then the name
 * over the type. The card is one button; `onRemove`, where the card is still
 * staged, is a sibling pinned to its corner, as on an image thumbnail.
 */
export function AttachmentFileCard({
  preview,
  name,
  fullName,
  typeLabel,
  actionLabel,
  onOpen,
  onContextMenu,
  removeLabel,
  onRemove,
}: {
  /** The thumbnail `<img>` or the type glyph, filling the square. */
  preview: React.ReactNode
  /** The name as shown, already cut to fit. */
  name: string
  /** The whole name, for the tooltip a cut name needs. */
  fullName: string
  typeLabel: string
  /** What the click does, named: `Open report.pdf`. */
  actionLabel: string
  onOpen: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void
  removeLabel?: string
  onRemove?: () => void
}) {
  return (
    <span className="relative inline-flex">
      <MediaButton
        aria-label={actionLabel}
        title={fullName === name ? undefined : fullName}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        className="h-12 max-w-[220px] bg-[color:var(--bg-surface)] text-left"
      >
        <span className={`flex h-full items-center gap-2 ${onRemove ? 'pr-8' : 'pr-3'}`}>
          <span className="flex h-full w-12 shrink-0 items-center justify-center overflow-hidden bg-[color:var(--bg-selected)] text-[color:var(--text-muted)]">
            {preview}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-meta font-medium text-[color:var(--text-strong)]">{name}</span>
            <span className="text-micro text-[color:var(--text-subtle)]">{typeLabel}</span>
          </span>
        </span>
      </MediaButton>
      {onRemove ? (
        <span className="absolute right-1 top-1">
          <CloseIconButton size="2xs" aria-label={removeLabel ?? `Remove ${fullName}`} onClick={onRemove} />
        </span>
      ) : null}
    </span>
  )
}
