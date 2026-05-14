import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export type WorkspacePanelHandle = {
  focus: () => void
}

type Props = {
  title: string
  subtitle?: string
  titleId?: string
  onClose?: () => void
  closeLabel?: string
  sidebar?: React.ReactNode
  toolbar?: React.ReactNode
  children: React.ReactNode
  bodyClassName?: string
  contentClassName?: string
  initialFocus?: boolean
}

export const WorkspacePanel = forwardRef<WorkspacePanelHandle, Props>(function WorkspacePanel(
  {
    title,
    subtitle,
    titleId,
    onClose,
    closeLabel = 'Close',
    sidebar,
    toolbar,
    children,
    bodyClassName,
    contentClassName,
    initialFocus = true,
  },
  ref,
) {
  const sectionRef = useRef<HTMLElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => sectionRef.current?.focus(),
  }))

  useEffect(() => {
    if (!initialFocus) return
    sectionRef.current?.focus()
  }, [initialFocus])

  const headingId = titleId ?? 'workspace-panel-title'

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] outline-none"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-4 py-3">
        <div className="min-w-0">
          <h2 id={headingId} className="truncate text-[15px] font-semibold tracking-tight text-[color:var(--text-strong)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 truncate text-[12px] leading-5 text-[color:var(--text-muted)]">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {toolbar}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 ${sidebar ? 'flex-col md:flex-row' : 'flex-col'}`}>
        {sidebar ? (
          <aside className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-1.5 md:w-48 md:border-b-0 md:border-r">
            {sidebar}
          </aside>
        ) : null}

        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName ?? ''}`}>
          <div className={contentClassName ?? 'w-full max-w-[760px] px-4 py-5'}>
            {children}
          </div>
        </div>
      </div>
    </section>
  )
})
