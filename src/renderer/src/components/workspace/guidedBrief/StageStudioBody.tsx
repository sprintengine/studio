import type { ReactNode } from 'react'
import { useStageStudioColumns, type StudioColumn } from './stageStudioColumns'

// The one studio layout every guided-brief stage shares: activity (terminal or
// interview) left, the stage's real artifacts in the middle, preview right.
// Three columns at desktop widths; on narrow widths the same panes stack and
// the container scrolls, so the terminal stays mounted, live, and
// input-capable alongside files and preview at every width. Extracted from the
// Multicode Design studio so strategist and architect stages render
// artifact-first too instead of a lone centered terminal.
//
// At desktop widths the activity and artifacts columns are user-resizable: drag
// the divider on a column's right edge (or focus it and use the arrow keys; Home
// resets). The preview column flexes to fill the remaining space. Widths persist
// across reloads — see stageStudioColumns.ts.
export function StageStudioBody({
  activity,
  artifacts,
  preview,
}: {
  activity: ReactNode
  artifacts: ReactNode
  preview: ReactNode
}) {
  const columns = useStageStudioColumns()

  if (!columns.isDesktop) {
    // Stacked, scrolling layout for narrow widths — widths do not apply.
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-6 py-6">
        <div className="flex min-h-[260px] min-w-0 flex-col">{activity}</div>
        <div className="flex min-h-[260px] min-w-0 flex-col">{artifacts}</div>
        <div className="flex min-h-[320px] min-w-0 flex-col">{preview}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 gap-0 overflow-hidden px-6 py-6">
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ width: columns.activityWidth, flex: '0 0 auto' }}
      >
        {activity}
      </div>
      <StudioColumnDivider
        column="activity"
        label="Resize activity column"
        active={columns.resizing === 'activity'}
        onPointerDown={columns.startResize('activity')}
        onKeyDown={columns.handleResizeKeyDown('activity')}
      />
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ width: columns.artifactsWidth, flex: '0 0 auto' }}
      >
        {artifacts}
      </div>
      <StudioColumnDivider
        column="artifacts"
        label="Resize artifacts column"
        active={columns.resizing === 'artifacts'}
        onPointerDown={columns.startResize('artifacts')}
        onKeyDown={columns.handleResizeKeyDown('artifacts')}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
    </div>
  )
}

function StudioColumnDivider({
  column,
  label,
  active,
  onPointerDown,
  onKeyDown,
}: {
  column: StudioColumn
  label: string
  active: boolean
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-column={column}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group relative mx-1 w-1.5 shrink-0 cursor-col-resize self-stretch focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
        }`}
      />
    </div>
  )
}
