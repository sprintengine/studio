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
      className="flex h-full min-h-0 flex-col bg-[#08090b] outline-none"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0d0e11] px-4 py-3">
        <div className="min-w-0">
          <h2 id={headingId} className="truncate text-[15px] font-semibold tracking-tight text-[#ececee]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 truncate text-[12px] leading-5 text-[#8a8a92]">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {toolbar}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
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
          <aside className="shrink-0 border-b border-[#1f2025] bg-[#0a0b0e] p-1.5 md:w-48 md:border-b-0 md:border-r">
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
