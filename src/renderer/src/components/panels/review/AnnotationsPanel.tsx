import type { ReviewAnnotation } from '../../../../../shared/review'
import { GhostButton } from '../../ui/Buttons'
import { anchorRangeLabel } from './anchorLabel'

interface AnnotationsPanelProps {
  annotations: ReviewAnnotation[]
  onJumpTo: (annotation: ReviewAnnotation) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
}

// The right "In this step" column — one summary card per annotation, the
// per-step version of a reviewer's summaries list. Every card can jump into the
// diff at its lines or ask the guide about it. Out-of-range annotations still
// appear here (they just have no inline zone).
export function AnnotationsPanel({ annotations, onJumpTo, onAskGuide }: AnnotationsPanelProps) {
  return (
    <div className="h-full overflow-y-auto border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4 py-4">
      <span className="mb-2.5 block text-[11px] font-medium text-[color:var(--text-subtle)]">In this step</span>
      {annotations.length === 0 ? (
        <p className="text-[12px] leading-5 text-[color:var(--text-subtle)]">
          No guide notes in this step — the files here read straight through.
        </p>
      ) : (
        annotations.map((annotation) => (
          <div
            key={annotation.id}
            className="mb-2.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5"
          >
            <div className="mb-1 flex items-baseline gap-2">
              <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight text-[color:var(--text-strong)]">
                {annotation.title}
              </span>
              <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                {anchorRangeLabel(annotation.anchor)}
              </span>
            </div>
            <p className="text-[11.5px] leading-5 text-[color:var(--text-muted)]">{annotation.summary}</p>
            <div className="mt-2 flex gap-2">
              <GhostButton onClick={() => onJumpTo(annotation)}>Jump to lines</GhostButton>
              <GhostButton onClick={() => onAskGuide(annotation)}>Ask</GhostButton>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

export default AnnotationsPanel
