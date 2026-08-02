import type {
  ChangeSetFile,
  DiffView,
  ReviewAnchor,
  ReviewAnnotation,
  ReviewComment,
  ReviewStep,
} from '../../../../shared/review'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { FileCard } from './FileCard'
import { commentsForFile } from './commentModel'

const DIFF_VIEW_ITEMS = [
  { value: 'side-by-side' as const, label: 'Side by side' },
  { value: 'inline' as const, label: 'Inline' },
]

interface StepPaneProps {
  step: ReviewStep
  fileByPath: Map<string, ChangeSetFile>
  readFiles: ReadonlySet<string>
  diffView: DiffView
  /** Omitted by hosts that pin the diff view; the switch is hidden with it. */
  onSetDiffView?: (view: DiffView) => void
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
  onSetDiffView,
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
      {/* The diff-view switch belongs to the diffs it switches, not to the page's
          chrome (owner, 2026-07-30): it rides this step's own heading row, right
          above the file cards it changes, and it is absent from the Overview
          pane — which has no diff to view either way. */}
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <h4 className="min-w-0 text-title font-semibold tracking-tight text-[color:var(--text-strong)]">{step.title}</h4>
        {onSetDiffView ? (
          <SegmentedControl
            ariaLabel="Diff view"
            items={DIFF_VIEW_ITEMS}
            value={diffView}
            onChange={onSetDiffView}
            size="sm"
            className="shrink-0"
          />
        ) : null}
      </div>
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
