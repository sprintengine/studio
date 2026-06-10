import { useMemo } from 'react'

import { InboxRow, LifecycleGlyph, PanelHeader } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { getWorkspaceActivity } from '../workspace/workspaceManagerHelpers'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import { buildSprintEngineNavRows } from '../../utils/sprintEnginesNav'
import type { WorkspacePanelProps } from '../../modules/renderer-host'

// Sprint Engines nav panel: the rail's answer to "what is running and what
// needs me". One row per Sprint Engine workspace, status carried by the same
// run-glyph rollup the sidebar uses (deriveWorkspaceRunGlyph), attention-first
// ordering. Selecting a row focuses that engine's workspace — the panel never
// creates or mutates runs.
//
// Follows knowledge/brand/aesthetic-north-star.md + panel-design-system.md:
// stripless nav-pane sibling of Files/Git/Backlog, hairline structure, and an
// earned status mark — resting engines render no glyph at all.
export default function SprintEnginesPanel(_props: WorkspacePanelProps) {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace)
  const terminalSessions = useTerminalSessions()

  const rows = useMemo(
    () =>
      buildSprintEngineNavRows(workspaces, (workspace) =>
        deriveWorkspaceRunGlyph(workspace, getWorkspaceActivity(workspace, terminalSessions)),
      ),
    [workspaces, terminalSessions],
  )

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      <PanelHeader
        tool="sprintengine"
        title="Sprint Engines"
        count={rows.length > 0 ? rows.length : undefined}
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
        <div aria-label="Sprint engines" className="flex-1 overflow-y-auto py-1">
          {rows.map((row) => (
            <InboxRow
              key={row.workspaceId}
              hideDot
              leading={
                row.glyph ? (
                  <LifecycleGlyph state={row.glyph.state} live={row.glyph.live} label={row.glyph.label} />
                ) : undefined
              }
              title={row.name}
              supporting={row.goal || undefined}
              trailing={row.totalTasks > 0 ? `${row.doneTasks}/${row.totalTasks}` : undefined}
              selected={row.workspaceId === activeWorkspaceId}
              onSelect={() => setActiveWorkspace(row.workspaceId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
