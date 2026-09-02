import type { ReviewAnnotation } from '../../../../shared/review'
import { GhostButton } from '../../components/ui/Buttons'
import { EmptyState } from '../../components/ui/EmptyState'
import { Section } from '../../components/ui/Section'
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
    // The column heading is the kit `Section` — one heading size and ink across
    // the doors and this canvas, rather than a private micro/subtle label — and
    // the section's own inset is the column's inset.
    <div className="h-full overflow-y-auto border-l border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]">
      <Section title="In this step" count={annotations.length > 0 ? annotations.length : undefined}>
        {annotations.length === 0 ? (
          <EmptyState
            density="list"
            title="No guide notes in this step"
            body="The files here read straight through."
          />
        ) : (
          annotations.map((annotation) => (
            <div
              key={annotation.id}
              className="mb-2.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5"
            >
              <div className="mb-1 flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-body font-medium leading-tight text-[color:var(--text-strong)]">
                  {annotation.title}
                </span>
                <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                  {anchorRangeLabel(annotation.anchor)}
                </span>
              </div>
              <p className="text-meta leading-5 text-[color:var(--text-muted)]">{annotation.summary}</p>
              <div className="mt-2 flex gap-2">
                <GhostButton onClick={() => onJumpTo(annotation)}>Jump to lines</GhostButton>
                <GhostButton onClick={() => onAskGuide(annotation)}>Ask</GhostButton>
              </div>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

export default AnnotationsPanel
