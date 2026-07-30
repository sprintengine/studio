import { InboxRow, Skeleton } from '../../ui'
import type { SwitchboardTaskRecord } from '../../../../../shared/switchboard'
import { formatRelativeTime, shortIdentifier } from '../../../utils/switchboardBoard'
import { inboxRowTone } from './types'

export function WatchtowerInboxRow({
  record,
  selected,
  onSelect,
}: {
  record: SwitchboardTaskRecord
  selected: boolean
  onSelect: () => void
}) {
  const task = record.task
  const tone = inboxRowTone(record)
  const descriptionPreview = task.description
    ? task.description.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? null
    : null
  const fallbackSupporting = task.labels.length > 0 ? task.labels.join(' · ') : null
  const title = (
    <>
      <span className="mr-2 font-mono tabular-nums text-micro text-[color:var(--text-muted)]">
        {shortIdentifier(record)}
      </span>
      {task.title}
    </>
  )
  return (
    <InboxRow
      tone={tone}
      title={title}
      supporting={descriptionPreview ?? fallbackSupporting ?? undefined}
      trailing={formatRelativeTime(task.createdAt)}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`${shortIdentifier(record)} ${task.title}`}
    />
  )
}

export function InboxSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading inbox">
      <ul>
        {Array.from({ length: 5 }).map((_, idx) => (
          <li key={idx} className="border-b border-[color:var(--border-subtle)] px-3 py-2">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-2.5 w-12 rounded bg-[color:var(--bg-surface-raised)]" />
              <Skeleton className="h-3 flex-1 rounded bg-[color:var(--bg-surface-raised)]" />
              <Skeleton className="h-2.5 w-10 rounded bg-[color:var(--bg-surface-raised)]" />
            </div>
            <Skeleton className="mt-1.5 h-2.5 w-[70%] rounded bg-[color:var(--bg-surface-raised)]" />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-meta font-semibold text-[color:var(--text-default)]">Triage</div>
      <div className="text-meta text-[color:var(--text-muted)]">
        Select an inbox task to inspect, edit, comment, or promote.
      </div>
    </div>
  )
}

