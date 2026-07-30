import type {
  ChangeSetFile,
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewComment,
  ReviewStep,
} from '../../../../../shared/review'
import { FileCard } from './FileCard'
import { commentsForFile } from './commentModel'

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
  comments: ReviewComment[]
  onCreateComment?: (path: string, anchor: ReviewAnchor, body: string) => void
  onEditComment?: (id: string, body: string) => void
  onDeleteComment?: (id: string) => void
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
  comments,
  onCreateComment,
  onEditComment,
  onDeleteComment,
}: StepPaneProps) {
  return (
    <div>
      <h4 className="mb-1.5 text-title font-semibold tracking-tight text-[color:var(--text-strong)]">{step.title}</h4>
      <p className="mb-4 max-w-[80ch] text-body leading-[1.55] text-[color:var(--text-muted)]">{step.narrative}</p>
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
            comments={commentsForFile(comments, entry.path)}
            onCreateComment={onCreateComment}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        )
      })}
    </div>
  )
}

export default StepPane
