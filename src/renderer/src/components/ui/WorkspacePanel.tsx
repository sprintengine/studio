import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { CloseIconButton } from './Buttons'
import { PanelHeader } from './PanelHeader'

// A full-height workspace surface: an identity row, an optional category rail,
// and a scrolling body. It drew its OWN title band at `px-4 py-3` with a
// `text-title` heading — a second header anatomy inside the kit that declares
// the first one, so the panel it wraps started its content at a different
// height from every panel that names itself through `ui/PanelHeader` (2112).
// It now composes that primitive, which is what makes "one header" true of the
// kit rather than only of the kit's consumers.

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
      <PanelHeader
        title={title}
        subtitle={subtitle}
        titleId={headingId}
        primaryAction={onClose ? <CloseIconButton size="md" aria-label={closeLabel} onClick={onClose} /> : undefined}
      />

      <div className={`flex min-h-0 flex-1 ${sidebar ? 'flex-col md:flex-row' : 'flex-col'}`}>
        {sidebar ? (
          <aside className="shrink-0 overflow-y-auto border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-1.5 md:w-48 md:border-b-0 md:border-r">
            {sidebar}
          </aside>
        ) : null}

        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName ?? ''}`}>
          <div className={contentClassName ?? 'mx-auto w-full max-w-[760px] px-4 py-5'}>{children}</div>
        </div>
      </div>
    </section>
  )
})
