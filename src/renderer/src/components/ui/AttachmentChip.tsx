import React from 'react'
import { CloseIconButton } from './Buttons'
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
