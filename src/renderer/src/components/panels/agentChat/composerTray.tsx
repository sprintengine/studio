// The tray tucked behind the composer's top edge: everything the chat has to
// say about the next message — what the agent is waiting on, what failed, what
// the cache will cost, what is queued — one row each, stacked in a single
// surface with the most urgent row against the composer.
//
// The tray sits under the composer — the composer follows it in the DOM, so it
// paints over it without a z-index of its own — and runs its bottom
// edge behind the composer's top, so it reads as something that slid out from
// under the field rather than a card parked above it. It collapses away when
// no row has anything to say: every row renders nothing when idle, and an
// empty tray is not drawn. Its top corners are `radius.composer-companion`, so
// the tray reads as part of the composer's set rather than a ramp card above a
// 22px box; its bottom corners are hidden under the composer.

import type React from 'react'
import { CloseIconButton, LifecycleGlyph } from '../../ui'
import { MarkdownAlertGlyph } from '../../ui/MarkdownAlertGlyph'

export type ComposerTrayTone = 'warn' | 'error' | 'neutral'

export function ComposerTray({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-composer-tray=""
      className="composer-tray relative mx-3 -mb-2.5 overflow-hidden rounded-t-[var(--sem-radius-composer-companion)] border border-b-0 border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pb-2.5 empty:hidden [&>*+*]:border-t [&>*+*]:border-[color:var(--border-subtle)]"
    >
      {children}
    </div>
  )
}

// A faint wash of the tone, not a slab of it: the glyph carries the tone, and
// a row stays readable stacked beside rows of another.
const TINT: Record<ComposerTrayTone, string | undefined> = {
  warn: 'color-mix(in srgb, var(--tone-warn) 7%, transparent)',
  error: 'color-mix(in srgb, var(--tone-error) 7%, transparent)',
  neutral: undefined,
}

function toneGlyph(tone: ComposerTrayTone) {
  if (tone === 'neutral')
    return <MarkdownAlertGlyph kind="note" className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />
  return <LifecycleGlyph state={tone === 'error' ? 'failed' : 'needs_input'} live={false} />
}

/**
 * One notice in the tray: its glyph, its sentence (wrapping when long — the
 * sentence is the notice, never shortened), and its actions on the right,
 * with an optional × after them.
 */
export function ComposerTrayRow({
  tone = 'neutral',
  glyph,
  actions,
  onDismiss,
  role,
  ariaLabel,
  children,
}: {
  tone?: ComposerTrayTone
  /** Replaces the tone's glyph; decorative, since the sentence names the state. */
  glyph?: React.ReactNode
  actions?: React.ReactNode
  onDismiss?: () => void
  /** Defaults to `alert` for an error and `status` otherwise. */
  role?: string
  ariaLabel?: string
  children: React.ReactNode
}) {
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-label={ariaLabel}
      data-tray-tone={tone}
      className="flex items-start gap-2 py-1 pl-3 pr-1.5"
      style={{ backgroundColor: TINT[tone] }}
    >
      <span aria-hidden="true" className="flex h-6 shrink-0 items-center">
        {glyph ?? toneGlyph(tone)}
      </span>
      <div className="min-w-0 flex-1 py-0.5 text-body leading-5 text-[color:var(--text-strong)]">{children}</div>
      {actions || onDismiss ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {onDismiss ? <CloseIconButton size="xs" aria-label="Dismiss" onClick={onDismiss} /> : null}
        </div>
      ) : null}
    </div>
  )
}
