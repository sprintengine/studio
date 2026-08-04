// Z-index ladder for the renderer. ONE ladder of record, and it is the design
// system's — `--sem-z-*`, aliased into the app as `--z-*` in assets/index.css
// (MC-2119). This comment used to declare a second one, and the two disagreed
// about the top of the stack:
//
//   in-flow depth       z-10 in-canvas HUD / in-card raise, z-20 docked panes,
//                       z-30 panel-internal popovers, z-[35] canvas overlays
//                       — app utilities; these describe depth within a pane,
//                       not overlay layers, and stay as they are.
//   overlay layers      --z-drawer 40, --z-popover 50, --z-menu 60,
//                       --z-modal 70, --z-toast 80.
//
// The kit already sat on the token values everywhere except here: Drawer 40,
// Popover and Tooltip 50, ContextMenu and PointerPopover 60. Modal alone used
// 50 while claiming to be "always above everything else" — which put it a tier
// BELOW the menus, so a context menu opened over a dialog painted on top of it.
// Consuming the token both fixes that and removes the second ladder.
import React, { useEffect, useRef } from 'react'
import { CloseIconButton } from './Buttons'
import { TruncatedText } from './TruncatedText'

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
      // Scrim: `.overlay-scrim`, matching the Command Palette and every other
      // full-screen overlay so modals read as one system. No backdrop-filter —
      // see the class definition for the framerate cliff it causes.
      className={`overlay-scrim ${contained ? 'absolute' : 'fixed'} inset-0 z-[var(--z-modal)] flex items-center justify-center p-6`}
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

// Header, body, and footer are separated by space, not by rules. The modal
// shell already draws its own edge; a divider under the title and another above
// the buttons cuts a small dialog into three boxed strips for no structural
// gain. The shell scrolls as one piece, so neither rule was a scroll affordance
// either.
export function ModalHeader({ title, subtitle, titleId, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pb-0 pt-5">
      <div className="min-w-0">
        <TruncatedText
          as="h2"
          id={titleId}
          text={title}
          className="text-title font-semibold tracking-tight text-[color:var(--text-strong)]"
        />
        {subtitle ? (
          <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {onClose ? (
        <CloseIconButton size="md" aria-label="Close" onClick={onClose} />
      ) : null}
    </div>
  )
}

export function ModalBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-5 py-4 ${className ?? ''}`}>{children}</div>
}

export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-2">
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
      <span className="mb-1.5 block text-micro font-medium text-[color:var(--text-default)]">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-micro leading-4 text-[color:var(--text-disabled)]">{hint}</span> : null}
    </label>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'

type ModalButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

const PRIMARY_STYLES =
  'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)] hover:bg-[color:var(--accent-primary-hover)] disabled:hover:bg-[color:var(--accent-primary)]'

export function ModalButton({ variant = 'ghost', className, ...rest }: ModalButtonProps) {
  const base =
    // `text-heading`, not Tailwind's `text-sm` — the same 14px, but on the
    // ramp, so it moves if the ramp moves (MC-2119).
    'rounded-md px-3.5 py-2 text-heading font-semibold transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-45'
  const styles: Record<ButtonVariant, string> = {
    primary: PRIMARY_STYLES,
    ghost:
      'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
    danger: 'bg-[color:var(--tone-error)] text-[color:var(--tone-error-ink)]',
  }
  return <button {...rest} className={`${base} ${styles[variant]} ${className ?? ''}`} />
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-micro font-medium text-[color:var(--text-default)]">
      {children}
    </div>
  )
}
