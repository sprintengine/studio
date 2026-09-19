import React from 'react'
import { GhostButton } from './Buttons'
import { StatusDot } from './StatusDot'
import { TruncatedText } from './TruncatedText'

type BannerTone = 'error' | 'warn'

export type BannerProps = {
  tone: BannerTone
  message: string
  onRetry?: () => void
  /** Label of the retry control. Defaults to "Retry"; name the context where
   *  that alone is ambiguous ("Retry loading sessions"), per the spec. */
  retryLabel?: string
  /**
   * The recovery slot, for a condition whose recovery is not spelled "Retry" —
   * a "Relink" beside the retry on a missing folder, or the progress line while
   * a refresh is in flight. It sits after the Retry when both are given
   * (the hand-rolled strips this replaced had labelled actions, and a
   * banner that cannot carry them is a banner nobody adopts).
   *
   * Still one recovery cluster, not a toolbar: if it needs a third control, the
   * condition belongs in an `InlineNotice` at the failure site.
   */
  action?: React.ReactNode
}

/**
 * Panel-spanning error/warn strip. Sits at the top of a panel's content area,
 * leads with a status dot, and offers an optional Retry. For inline-scoped
 * advisories inside a section, use InlineNotice instead.
 */
export function Banner({ tone, message, onRetry, retryLabel = 'Retry', action }: BannerProps) {
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
      {onRetry || action ? (
        <span className="flex shrink-0 items-center gap-2">
          {onRetry ? <GhostButton onClick={onRetry}>{retryLabel}</GhostButton> : null}
          {action}
        </span>
      ) : null}
    </div>
  )
}
