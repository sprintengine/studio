import type { ReactNode } from 'react'

// The one studio layout every guided-brief stage shares: activity (terminal or
// interview) left, the stage's real artifacts in the middle, preview right.
// Three columns at desktop widths; on narrow widths the same panes stack and
// the container scrolls, so the terminal stays mounted, live, and
// input-capable alongside files and preview at every width. Extracted from the
// Multicode Design studio so strategist and architect stages render
// artifact-first too instead of a lone centered terminal.
export function StageStudioBody({
  activity,
  artifacts,
  preview,
}: {
  activity: ReactNode
  artifacts: ReactNode
  preview: ReactNode
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto px-6 py-6 lg:grid-cols-[minmax(0,320px)_minmax(0,340px)_minmax(0,1fr)] lg:overflow-hidden">
      <div className="flex min-h-[260px] min-w-0 flex-col lg:min-h-0">{activity}</div>
      <div className="flex min-h-[260px] min-w-0 flex-col lg:min-h-0">{artifacts}</div>
      <div className="flex min-h-[320px] min-w-0 flex-col lg:min-h-0">{preview}</div>
    </div>
  )
}
