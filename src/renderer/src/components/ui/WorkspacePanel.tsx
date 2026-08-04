import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { CloseIconButton } from './Buttons'
import { TruncatedText } from './TruncatedText'

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
          <h2 id={headingId} className="truncate text-title font-semibold tracking-tight text-[color:var(--text-strong)]">
            {title}
          </h2>
          {subtitle ? (
            <TruncatedText
              as="p"
              text={subtitle}
              className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]"
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {toolbar}
          {onClose ? (
            <CloseIconButton size="md" aria-label={closeLabel} onClick={onClose} />
          ) : null}
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 ${sidebar ? 'flex-col md:flex-row' : 'flex-col'}`}>
        {sidebar ? (
          <aside className="shrink-0 overflow-y-auto border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-1.5 md:w-48 md:border-b-0 md:border-r">
            {sidebar}
          </aside>
        ) : null}

        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName ?? ''}`}>
          <div className={contentClassName ?? 'mx-auto w-full max-w-[760px] px-4 py-5'}>
            {children}
          </div>
        </div>
      </div>
    </section>
  )
})
