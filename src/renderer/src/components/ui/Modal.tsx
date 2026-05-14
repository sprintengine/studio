// Z-index ladder for the renderer. Use these tiers, not arbitrary values:
//   z-10 — in-canvas HUD, tooltips, in-card raise, editor overlays
//   z-20 — docked inspector panes (Task Detail, Memory Preview)
//   z-30 — panel-internal popovers and action menus (CLI picker, board overflow)
//   z-40 — app-shell popovers and dropdowns (notifications, account menu)
//   z-50 — modals and the command palette (always above everything else)
import React, { useEffect, useRef } from 'react'

type ModalProps = {
  open: boolean
  onClose: () => void
  labelledBy?: string
  width?: number | string
  children: React.ReactNode
  contained?: boolean
}

export function Modal({ open, onClose, labelledBy, width = 560, children, contained = false }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handle = window.requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      if (node.contains(document.activeElement)) return
      node.focus()
    })
    return () => {
      window.cancelAnimationFrame(handle)
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className={`${contained ? 'absolute' : 'fixed'} inset-0 z-50 flex items-center justify-center bg-[color:var(--surface-overlay-backdrop)] p-6 backdrop-blur-[2px]`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{ width, maxWidth: '95vw' }}
        className="max-h-[92vh] overflow-y-auto rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] outline-none"
      >
        {children}
      </div>
    </div>
  )
}

type ModalHeaderProps = {
  title: string
  subtitle?: string
  titleId?: string
  onClose?: () => void
}

export function ModalHeader({ title, subtitle, titleId, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-subtle)] px-5 py-4">
      <div className="min-w-0">
        <h2 id={titleId} className="truncate text-[15px] font-semibold tracking-tight text-[color:var(--text-strong)]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-2 py-1 text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

export function ModalBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-5 py-5 ${className ?? ''}`}>{children}</div>
}

export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--border-subtle)] px-5 py-3">
      {children}
    </div>
  )
}

type FieldProps = {
  label: string
  hint?: string
  children: React.ReactNode
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium text-[color:var(--text-default)]">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11px] leading-4 text-[color:var(--text-disabled)]">{hint}</span> : null}
    </label>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'

// ModalAccent values are retained for type compatibility with the 5 remaining
// consumer call sites (`accent="violet" | "copper" | "gold"`). Per the
// app-wide audit plan §4 one-accent restraint, every variant now renders the
// canonical product accent (`--accent-primary`). The architect should schedule
// a follow-up task to remove the now-redundant `accent` prop from those
// consumers; see
// .multi-code/sprintengine/2026-05-13-app-wide-linear-grade-audit-v3/reviews/modal-hex-audit.md.
export type ModalAccent = 'brand' | 'violet' | 'copper' | 'gold'

type ModalButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  accent?: ModalAccent
}

const PRIMARY_STYLES =
  'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)] hover:bg-[color:var(--accent-primary-hover)] disabled:hover:bg-[color:var(--accent-primary)]'

export function ModalButton({ variant = 'ghost', accent: _accent, className, ...rest }: ModalButtonProps) {
  const base =
    'rounded-md px-3.5 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-45'
  const styles: Record<ButtonVariant, string> = {
    primary: PRIMARY_STYLES,
    ghost:
      'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
    danger: 'bg-[color:var(--tone-error)] text-[color:var(--text-on-accent)]',
  }
  return <button {...rest} className={`${base} ${styles[variant]} ${className ?? ''}`} />
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium text-[color:var(--text-default)]">
      {children}
    </div>
  )
}
