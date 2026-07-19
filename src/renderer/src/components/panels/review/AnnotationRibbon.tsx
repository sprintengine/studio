import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ReviewAnnotation } from '../../../../../shared/review'
import { GhostButton } from '../../ui/Buttons'
import { anchorRangeLabel } from './anchorLabel'

interface AnnotationRibbonProps {
  annotation: ReviewAnnotation
  onAskGuide: (annotation: ReviewAnnotation) => void
  // Reports the ribbon's rendered height so the host can size its Monaco view
  // zone; fires on mount and whenever expansion changes the height.
  onMeasured: (height: number) => void
}

const SparkMark = () => (
  <span
    className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--accent-primary)]"
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

  return (
    <div
      ref={ref}
      className="flex gap-2.5 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] py-2.5 pl-[55px] pr-3.5"
    >
      <SparkMark />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => expandable && setOpen((value) => !value)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          className={`block w-full text-left text-[13px] leading-5 text-[color:var(--text-default)] ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        >
          <span className="font-medium text-[color:var(--text-strong)]">{annotation.title}</span>
          <span className="text-[color:var(--text-default)]"> — {annotation.summary}</span>
          <span className="ml-2 font-mono text-[10.5px] tabular-nums text-[color:var(--text-subtle)]">
            {anchorRangeLabel(annotation.anchor)}
          </span>
        </button>
        {open && annotation.detail ? (
          <p className="mt-1.5 max-w-[72ch] text-[13px] leading-5 text-[color:var(--text-muted)]">{annotation.detail}</p>
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
