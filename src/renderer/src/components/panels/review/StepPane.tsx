import type { ChangeSetFile, DiffView, ReviewAnnotation, ReviewStep } from '../../../../../shared/review'
import { FileCard } from './FileCard'

interface StepPaneProps {
  step: ReviewStep
  fileByPath: Map<string, ChangeSetFile>
  readFiles: ReadonlySet<string>
  diffView: DiffView
  monacoTheme: 'vs' | 'vs-dark'
  onToggleRead: (path: string) => void
  onRequestComment: (path: string, line: number) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
  onOrphans: (path: string, orphans: ReviewAnnotation[]) => void
  registerReveal: (path: string, reveal: ((line: number) => void) | null) => void
}

// The active step's center pane: its narrative, then one file card per assigned
// file (with that file's annotations threaded down as view zones). A file the
// step names but the changeset lacks is skipped defensively rather than crashing
// — the brief validator makes this impossible for a valid brief.
export function StepPane({
  step,
  fileByPath,
  readFiles,
  diffView,
  monacoTheme,
  onToggleRead,
  onRequestComment,
  onAskGuide,
  onOrphans,
  registerReveal,
}: StepPaneProps) {
  return (
    <div>
      <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-[color:var(--text-strong)]">{step.title}</h4>
      <p className="mb-4 max-w-[80ch] text-[13px] leading-[1.55] text-[color:var(--text-muted)]">{step.narrative}</p>
      {step.files.map((entry) => {
        const file = fileByPath.get(entry.path)
        if (!file) return null
        return (
          <FileCard
            key={entry.path}
            file={file}
            why={entry.why}
            readingNote={entry.readingNote}
            annotations={step.annotations.filter((annotation) => annotation.path === entry.path)}
            read={readFiles.has(entry.path)}
            diffView={diffView}
            monacoTheme={monacoTheme}
            onToggleRead={onToggleRead}
            onRequestComment={onRequestComment}
            onAskGuide={onAskGuide}
            onOrphans={onOrphans}
            registerReveal={registerReveal}
          />
        )
      })}
    </div>
  )
}

export default StepPane
