import React from 'react'
import { LifecycleGlyph } from './LifecycleGlyph'

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
 * One idiom, both tones: a 1px neutral hairline, a soft tinted background, and
 * a tone-coloured glyph at the leading edge. The body text stays neutral
 * (readable) — the glyph carries the tone, and the tint reinforces it, which is
 * why it survives greyscale.
 *
 * No left tone-bar. A 2px coloured stripe down one edge is decoration wearing a
 * hairline's clothes: it doubles the shell's own border, breaks the 1px hairline
 * rule, and leaves the tone carried by colour alone. The glyph vocabulary is the
 * app's existing lifecycle set — `failed` (ring + ×) for a failure, `needs_input`
 * (ring + !) for a degraded state — so a notice and a row say the same thing with
 * the same shape.
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
  const softVar = tone === 'error' ? 'var(--tone-error-soft)' : 'var(--tone-warn-soft)'
  // `role` already announces the tone, so the glyph is decorative to a reader
  // and shape-carrying to an eye.
  const glyph = (
    // mt-1 centres the 16px glyph on the 24px first line of the message.
    <LifecycleGlyph state={tone === 'error' ? 'failed' : 'needs_input'} live={false} className="mt-1" />
  )

  const details = detail ? (
    <details className="mt-1.5">
      <summary className="cursor-pointer select-none text-meta text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]">
        Show details
      </summary>
      <pre className="font-mono mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-[3px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1.5 text-micro leading-[1.5] text-[color:var(--text-muted)]">
        {detail}
      </pre>
    </details>
  ) : null

  // Structured card: plain sentence → what it means → raw detail → action row.
  if (title !== undefined) {
    return (
      <div
        role={tone === 'error' ? 'alert' : 'status'}
        className={[
          'flex items-start gap-2.5 rounded-[5px] border border-[color:var(--border-subtle)] px-3 py-2',
          className ?? '',
        ].join(' ')}
        style={{ backgroundColor: softVar }}
      >
        {glyph}
        <div className="min-w-0 flex-1">
          <div className="text-body leading-6 text-[color:var(--text-strong)]">{title}</div>
          {hint ? <div className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">{hint}</div> : null}
          {details}
          {action ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>
      </div>
    )
  }

  // Plain advisory: a single neutral line, optional trailing action.
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={[
        'flex items-start gap-2.5 rounded-[5px] border border-[color:var(--border-subtle)] px-3 py-2 text-body leading-6 text-[color:var(--text-strong)]',
        className ?? '',
      ].join(' ')}
      style={{ backgroundColor: softVar }}
    >
      {glyph}
      <div className="min-w-0 flex-1">
        {children}
        {details}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
