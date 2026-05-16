import React from 'react'

export type InlineNoticeTone = 'error' | 'warn'

export type InlineNoticeProps = {
  tone: InlineNoticeTone
  children: React.ReactNode
  /**
   * Optional inline action — e.g. "Reconnect", "Open file". Not Retry: that is
   * panel-spanning chrome and lives on `Banner` instead.
   */
  action?: React.ReactNode
  className?: string
}

/**
 * Scoped error / warn advisory rendered inside a section, drawer, or detail
 * pane. Anatomy: left tone accent + tinted background, tone-coloured body
 * text, optional trailing action. For panel-spanning chrome with Retry use
 * `Banner` instead.
 */
export function InlineNotice({ tone, children, action, className }: InlineNoticeProps) {
  const toneVar = tone === 'error' ? 'var(--tone-error)' : 'var(--tone-warn)'
  const softVar = tone === 'error' ? 'var(--tone-error-soft)' : 'var(--tone-warn-soft)'
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'flex items-start justify-between gap-3 rounded-[5px] border-l-2 px-3 py-2 text-[13px] leading-6',
        className ?? '',
      ].join(' ')}
      style={{ borderLeftColor: toneVar, backgroundColor: softVar, color: toneVar }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
