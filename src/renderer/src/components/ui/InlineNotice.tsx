import React from 'react'

export type InlineNoticeTone = 'error' | 'warn'

/**
 * Tone convention (T13 / backlog 1732) — the one rule every surface follows:
 *
 *   error (red)  — a FAILURE. Something the user tried did not happen. Always
 *                  pair it with a recovery action (a retry, a reconnect, an
 *                  "open settings"); never a dead end.
 *   warn (amber) — DEGRADED BUT WORKING. The feature still runs, in a reduced
 *                  or paused state (a token expiring soon, posting paused, a
 *                  partial result). Not a failure — do not colour a hard
 *                  failure amber, nor a soft/degraded state red.
 *
 * One idiom, both tones: a left tone-accent + soft tinted background. The body
 * text stays neutral (readable) — the tint carries the tone. This matches the
 * "one error card" of the 2026-07-20 post-merge-ui-polish mockup and avoids the
 * low-contrast tone-on-tint text the token file (`--tone-*-on-tint`) warns of.
 */
export type InlineNoticeProps = {
  tone: InlineNoticeTone
  /**
   * Structured "error card" content (preferred for failures). Feed it from
   * `presentError()` or a domain adapter like `presentTrackerError()`: a plain
   * sentence (`title`) + what-it-means (`hint`), with any raw technical string
   * (`detail`) tucked behind a "Show details" disclosure — never inline.
   */
  title?: string
  hint?: string
  /**
   * Raw technical string (ENOENT / HTTP body / zod / stack). Rendered only
   * inside a collapsed "Show details" disclosure. Omit when there is none.
   */
  detail?: string
  /**
   * Simple one-line advisory body, when there is no structured `title` — e.g. a
   * short degraded-state note. Ignored when `title` is set.
   */
  children?: React.ReactNode
  /**
   * Recovery / navigation action(s). For a structured card they sit on their
   * own row beneath the message (mockup `.actions`); for a plain advisory they
   * sit inline at the trailing edge. Pass a fragment for more than one.
   */
  action?: React.ReactNode
  className?: string
}

/**
 * Scoped error / warn advisory rendered inside a section, drawer, or detail
 * pane — the app's single "error card". For panel-spanning chrome with a
 * leading status dot and a Retry, use `Banner` instead.
 */
export function InlineNotice({ tone, title, hint, detail, children, action, className }: InlineNoticeProps) {
  const toneVar = tone === 'error' ? 'var(--tone-error)' : 'var(--tone-warn)'
  const softVar = tone === 'error' ? 'var(--tone-error-soft)' : 'var(--tone-warn-soft)'

  const details = detail ? (
    <details className="mt-1.5">
      <summary className="cursor-pointer select-none text-[12px] text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]">
        Show details
      </summary>
      <pre className="font-mono mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-[3px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1.5 text-[11px] leading-[1.5] text-[color:var(--text-muted)]">
        {detail}
      </pre>
    </details>
  ) : null

  // Structured card: plain sentence → what it means → raw detail → action row.
  if (title !== undefined) {
    return (
      <div
        role={tone === 'error' ? 'alert' : 'status'}
        className={['rounded-[5px] border-l-2 px-3 py-2', className ?? ''].join(' ')}
        style={{ borderLeftColor: toneVar, backgroundColor: softVar }}
      >
        <div className="text-[13px] leading-6 text-[color:var(--text-strong)]">{title}</div>
        {hint ? <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">{hint}</div> : null}
        {details}
        {action ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    )
  }

  // Plain advisory: a single neutral line, optional trailing action.
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'flex items-start justify-between gap-3 rounded-[5px] border-l-2 px-3 py-2 text-[13px] leading-6 text-[color:var(--text-strong)]',
        className ?? '',
      ].join(' ')}
      style={{ borderLeftColor: toneVar, backgroundColor: softVar }}
    >
      <div className="min-w-0 flex-1">
        {children}
        {details}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
