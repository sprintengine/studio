import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ReviewAnnotation } from '../../../../shared/review'
import { GhostButton } from '../../components/ui/Buttons'
import { FOCUS_RING_INSET_CLASS } from '../../components/ui/tokens'
import { anchorRangeLabel } from './anchorLabel'
import { ZONE_CONTENT_INSET } from './annotationZones'

interface AnnotationRibbonProps {
  annotation: ReviewAnnotation
  onAskGuide: (annotation: ReviewAnnotation) => void
  // Reports the ribbon's rendered height so the host can size its Monaco view
  // zone; fires on mount and whenever expansion changes the height.
  onMeasured: (height: number) => void
}

const SparkMark = () => (
  <span
    className="mt-0.5 inline-flex size-icon-sm shrink-0 items-center justify-center rounded-xs bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--accent-primary)]"
    aria-hidden="true"
  >
    <svg viewBox="0 0 16 16" className="icon-xs" fill="currentColor">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
    </svg>
  </span>
)

// The guide's inline explanation, rendered inside a Monaco view zone under the
// anchored code. Collapsed it shows title + summary + line range; expanding
// reveals the longer detail and the "Ask the guide" action. It reports its own
// height so the host reserves exactly the right zone size.
export function AnnotationRibbon({ annotation, onAskGuide, onMeasured }: AnnotationRibbonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (ref.current) onMeasured(ref.current.scrollHeight)
  }, [open, annotation, onMeasured])

  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => onMeasured(node.scrollHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [onMeasured])

  const expandable = Boolean(annotation.detail)

  // The head line is copy first. With a detail to reveal it is a disclosure
  // button; without one it is plain text, not a disabled button — a control
  // that is off has to dim to the disabled canon (45%), and dimming the one
  // line that explains the code would defeat the ribbon.
  const headLine = (
    <>
      {expandable ? (
        <svg
          viewBox="0 0 16 16"
          className="icon-xs mr-1 inline-block shrink-0 align-[-1px] text-[color:var(--text-subtle)] transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          fill="none"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      <span className="font-medium text-[color:var(--text-strong)]">{annotation.title}</span>
      <span className="text-[color:var(--text-default)]"> — {annotation.summary}</span>
      <span className="ml-2 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
        {anchorRangeLabel(annotation.anchor)}
      </span>
    </>
  )

  return (
    <div
      ref={ref}
      className={`flex gap-2.5 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] py-2.5 ${ZONE_CONTENT_INSET} pr-4`}
    >
      <SparkMark />
      <div className="min-w-0 flex-1">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className={`block w-full cursor-pointer text-left text-body leading-5 text-[color:var(--text-default)] ${FOCUS_RING_INSET_CLASS}`}
          >
            {headLine}
          </button>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-default)]">{headLine}</p>
        )}
        {open && annotation.detail ? (
          <p className="mt-1.5 max-w-[72ch] text-body leading-5 text-[color:var(--text-muted)]">{annotation.detail}</p>
        ) : null}
        {open ? (
          <div className="mt-2">
            <GhostButton onClick={() => onAskGuide(annotation)}>Ask the guide</GhostButton>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default AnnotationRibbon
