import React, { Suspense } from 'react'

import type { ChangeSetFile, DiffView, ReviewAnchor, ReviewAnnotation, ReviewComment } from '../../../../../shared/review'
import { fileWhyLine } from './reviewSelectors'

// Monaco lives behind a lazy boundary: it stays out of the eager boot chunk
// (bundle budget) and out of the fixture harness's static render, which shows the
// fallback instead of mounting an editor.
const ReviewDiffEditor = React.lazy(() => import('./ReviewDiffEditor'))

interface FileCardProps {
  file: ChangeSetFile
  why: string
  readingNote?: 'read-closely' | 'mechanical-skim'
  annotations: ReviewAnnotation[]
  read: boolean
  diffView: DiffView
  monacoTheme: 'vs' | 'vs-dark'
  onToggleRead: (path: string) => void
  onRequestComment: (path: string, line: number) => void
  onAskGuide: (annotation: ReviewAnnotation) => void
  onOrphans: (path: string, orphans: ReviewAnnotation[]) => void
  registerReveal?: (path: string, reveal: ((line: number) => void) | null) => void
  comments?: ReviewComment[]
  onCreateComment?: (path: string, anchor: ReviewAnchor, body: string) => void
  onEditComment?: (id: string, body: string) => void
  onDeleteComment?: (id: string) => void
}

function DeltaCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {additions > 0 ? <span className="text-[color:var(--tone-good)]">+{additions}</span> : null}
      {additions > 0 && deletions > 0 ? ' ' : null}
      {deletions > 0 ? <span className="text-[color:var(--tone-error)]">−{deletions}</span> : null}
    </span>
  )
}

function MarkReadButton({ read, onClick }: { read: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={read}
      className={`interactive inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border px-2.5 text-[12px] font-medium focus-visible:focus-ring ${
        read
          ? 'border-transparent bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
          : 'border-[color:var(--border-default)] bg-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {read ? (
        <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {read ? 'Read' : 'Mark read'}
    </button>
  )
}

// One file in a step: identity + why-line + delta counts + read toggle, then the
// diff body. The why-line always renders directly under the path — it is the
// reason this file is in the walkthrough.
export function FileCard({
  file,
  why,
  readingNote,
  annotations,
  read,
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
}: FileCardProps) {
  const displayPath = file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  return (
    <div
      data-review-file={file.path}
      className="mb-4 overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
    >
      <div className="flex min-h-[38px] items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11.5px] text-[color:var(--text-strong)]" title={displayPath}>
            {displayPath}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-[color:var(--text-subtle)]">
            <span className="font-medium text-[color:var(--text-muted)]">Why:</span> {fileWhyLine(why, readingNote)}
          </span>
        </span>
        <DeltaCounts additions={file.additions} deletions={file.deletions} />
        <MarkReadButton read={read} onClick={() => onToggleRead(file.path)} />
      </div>
      {file.binary ? (
        <p className="px-3 py-3 text-[12px] text-[color:var(--text-subtle)]">Binary file — no diff to show.</p>
      ) : file.hunks.length === 0 ? (
        <p className="px-3 py-3 text-[12px] text-[color:var(--text-subtle)]">No line changes.</p>
      ) : (
        <Suspense
          fallback={<p className="px-3 py-3 text-[12px] text-[color:var(--text-subtle)]">Loading diff…</p>}
        >
          <ReviewDiffEditor
            file={file}
            annotations={annotations}
            diffView={diffView}
            monacoTheme={monacoTheme}
            onRequestComment={onRequestComment}
            onAskGuide={onAskGuide}
            onOrphans={onOrphans}
            registerReveal={registerReveal}
            comments={comments}
            onCreateComment={onCreateComment}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        </Suspense>
      )}
    </div>
  )
}

export default FileCard
