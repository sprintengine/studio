import React from 'react'
import { GhostButton } from './Buttons'
import { StatusDot } from './StatusDot'
import { TruncatedText } from './TruncatedText'

export type BannerTone = 'error' | 'warn'

export type BannerProps = {
  tone: BannerTone
  message: string
  onRetry?: () => void
}

/**
 * Panel-spanning error/warn strip. Sits at the top of a panel's content area,
 * leads with a status dot, and offers an optional Retry. For inline-scoped
 * advisories inside a section, use InlineNotice instead.
 */
export function Banner({ tone, message, onRetry }: BannerProps) {
  const softVar = tone === 'error' ? 'var(--tone-error-soft)' : 'var(--tone-warn-soft)'
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] px-3 py-2 text-meta text-[color:var(--text-strong)]"
      style={{ backgroundColor: softVar }}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={tone} />
        <TruncatedText as="span" text={message} className="min-w-0" />
      </span>
      {onRetry ? <GhostButton onClick={onRetry}>Retry</GhostButton> : null}
    </div>
  )
}
