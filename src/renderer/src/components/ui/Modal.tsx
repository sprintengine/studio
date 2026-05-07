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
    ref.current?.focus()
    return () => previous?.focus()
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
      className={`${contained ? 'absolute' : 'fixed'} inset-0 z-50 flex items-center justify-center bg-[#08090b]/70 p-6 backdrop-blur-[2px]`}
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
        className="max-h-[92vh] overflow-y-auto rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#0d0e11] outline-none"
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
    <div className="flex items-start justify-between gap-4 border-b border-[rgba(255,255,255,0.06)] px-5 py-4">
      <div className="min-w-0">
        <h2 id={titleId} className="truncate text-[15px] font-semibold tracking-tight text-[#ececee]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">{subtitle}</p>
        ) : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-2 py-1 text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
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
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[rgba(255,255,255,0.06)] px-5 py-3">
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
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a5a63]">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11px] leading-4 text-[#5a5a63]">{hint}</span> : null}
    </label>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'

type ModalButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

export function ModalButton({ variant = 'ghost', className, ...rest }: ModalButtonProps) {
  const base = 'rounded-md px-3.5 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 disabled:cursor-not-allowed disabled:opacity-45'
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-[#5c7cff] text-[#08090b] hover:bg-[#6e8eff] disabled:hover:bg-[#5c7cff]',
    ghost: 'text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]',
    danger: 'bg-[#ff5a5f] text-[#08090b] hover:bg-[#ff787c]',
  }
  return <button {...rest} className={`${base} ${styles[variant]} ${className ?? ''}`} />
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a5a63]">
      {children}
    </div>
  )
}
