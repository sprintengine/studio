import { useMemo } from 'react'

import { CloseIconButton, InboxRow, LifecycleGlyph, PanelHeader } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { getWorkspaceActivity } from './workspaceManagerHelpers'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import { buildSprintEngineNavRows } from '../../utils/sprintEnginesNav'
import type { WorkspaceId } from '../../types/workspace'

type SprintEnginesAsideProps = {
  // The window's active workspace, not the global one — selection highlights
  // and row activation stay window-scoped like the sidebar's.
  activeWorkspaceId: WorkspaceId | null
  // Workspaces routed to THIS window. setActiveWorkspaceForWindow silently
  // no-ops for a workspace hosted in another window, so those rows render
  // disabled instead of swallowing the click.
  windowWorkspaceIds: ReadonlySet<string>
  onSelectWorkspace: (workspaceId: WorkspaceId) => void
  onClose: () => void
}

// The global Sprint Engines aside: "what is running and what needs me" across
// every workspace. It docks OUTSIDE the rounded workspace card, on the same
// --bg-app gutter as the workspace sidebar, so the ink scale itself says
// "app-level survey" — per-workspace tools (Files / Git / Backlog) live inside
// the card; this surface deliberately does not. Selecting a row swaps the
// workspace card underneath while the aside stays put, which is the whole
// point of hoisting it out of the per-workspace FlexLayout model.
//
// Follows knowledge/brand/aesthetic-north-star.md + panel-design-system.md:
// hairline structure, attention-first ordering via buildSprintEngineNavRows,
// and an earned status mark — resting engines render no glyph at all.
export default function SprintEnginesAside({
  activeWorkspaceId,
  windowWorkspaceIds,
  onSelectWorkspace,
  onClose,
}: SprintEnginesAsideProps) {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const terminalSessions = useTerminalSessions()

  const rows = useMemo(
    () =>
      buildSprintEngineNavRows(workspaces, (workspace) =>
        deriveWorkspaceRunGlyph(workspace, getWorkspaceActivity(workspace, terminalSessions)),
      ),
    [workspaces, terminalSessions],
  )

  return (
    <aside
      aria-label="Sprint engines"
      className="flex h-full w-[296px] shrink-0 flex-col bg-[color:var(--bg-app)]"
    >
      <PanelHeader
        tool="sprintengine"
        title="Sprint Engines"
        subtitle="All workspaces"
        count={rows.length > 0 ? rows.length : undefined}
        primaryAction={<CloseIconButton aria-label="Close Sprint Engines" onClick={onClose} />}
      />
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-xs">
            <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
              No sprint engines yet
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Sprint Engine workspaces appear here with their live run state. Start one from a
              Backlog item with &ldquo;Start Sprint Engine&rdquo;, or create a Sprint Engine
              workspace.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {rows.map((row) => {
            const inWindow = windowWorkspaceIds.has(row.workspaceId)
            return (
              <InboxRow
                key={row.workspaceId}
                hideDot
                leading={
                  row.glyph ? (
                    <LifecycleGlyph state={row.glyph.state} live={row.glyph.live} label={row.glyph.label} />
                  ) : undefined
                }
                title={row.name}
                supporting={inWindow ? row.goal || undefined : 'Open in another window'}
                trailing={row.totalTasks > 0 ? `${row.doneTasks}/${row.totalTasks}` : undefined}
                selected={row.workspaceId === activeWorkspaceId}
                disabled={!inWindow}
                ariaLabel={inWindow ? undefined : `${row.name} — open in another window`}
                onSelect={() => onSelectWorkspace(row.workspaceId)}
              />
            )
          })}
        </div>
      )}
    </aside>
  )
}
