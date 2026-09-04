import React from 'react'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../types/workspace'
import type { FuturePlanWorkspaceSource } from '../../../types/workspace'
import { SuspenseFallback } from '../../ui/SuspenseFallback'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { paneKindRetainsPanel } from './paneKinds'

// The pane's content region: one layer per tab that needs to stay mounted
// (terminal, later browser) plus the active tab. Inactive retained layers are
// `invisible` rather than `hidden` so xterm keeps its measured size and a tab
// switch never refits the buffer; everything else mounts only while showing.

const FileExplorer = React.lazy(() => import('../../panels/FileExplorer'))
const PlainTerminalPanel = React.lazy(() => import('../../panels/PlainTerminalPanel'))
// Monaco rides with the diff viewer; lazy so a pane without a Diff tab never
// pays for it.
const DiffViewer = React.lazy(() =>
  import('../../auxWindows/DiffViewer').then((module) => ({ default: module.DiffViewer })),
)

// The explicit, labelled unavailable state (never a silently blank surface) —
// the same copy WorkspaceLayout shows for a disabled or stale FlexLayout tab.
function PaneUnavailable() {
  return (
    <div
      role="note"
      aria-label="Panel unavailable"
      className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
    >
      <p className="text-meta font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
      <p className="max-w-xs text-micro leading-5 text-[color:var(--text-muted)]">
        This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
      </p>
    </div>
  )
}

type PaneTabPanelProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  onDiffCountChange?: (count: number) => void
}

function PaneTabPanel({ workspaceId, tab, onStartFuturePlan, onDiffCountChange }: PaneTabPanelProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // The diff reads the worktree the workspace is mounted on, not the parent
  // checkout a run workspace's folderPath names (the WorkspaceIdentity rule).
  const diffRepoRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return resolveWorkspaceWorktree(ws)?.gitRoot ?? ws.folderPath ?? null
  })
  switch (tab.kind) {
    case 'files':
      return selectModuleEnabled(moduleOverrides, 'dev-tools')
        ? <FileExplorer workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />
        : <PaneUnavailable />
    case 'git': {
      // Git is a host-registered panel (git-module.ts); the pane renders the
      // registered component so a disabled module answers with absence.
      const GitPanel = getRendererHost().getPanel('git')
      return GitPanel && selectModuleEnabled(moduleOverrides, 'git')
        ? <GitPanel workspaceId={workspaceId} />
        : <PaneUnavailable />
    }
    case 'terminal':
      return tab.terminalId
        ? <PlainTerminalPanel workspaceId={workspaceId} terminalId={tab.terminalId} />
        : <PaneUnavailable />
    case 'diff':
      return diffRepoRoot && selectModuleEnabled(moduleOverrides, 'git')
        ? (
          <DiffViewer
            // Keyed on the repo only: a Git row click retargets the mounted
            // viewer through its focus props. Remounting per target (the aux
            // window's rule) disposes Monaco's models under the diff widget.
            key={diffRepoRoot}
            repoRoot={diffRepoRoot}
            focusPath={tab.diff?.focusPath ?? null}
            focusKind={tab.diff?.focusKind ?? null}
            variant="pane"
            onItemCountChange={onDiffCountChange}
          />
        )
        : <PaneUnavailable />
    default:
      return <PaneUnavailable />
  }
}

type WorkspacePaneBodyProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  activeTabId: string | null
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  onDiffCountChange?: (count: number) => void
}

export function WorkspacePaneBody({
  workspaceId,
  tabs,
  activeTabId,
  onStartFuturePlan,
  onDiffCountChange,
}: WorkspacePaneBodyProps) {
  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        if (!active && !paneKindRetainsPanel(tab.kind)) return null
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`pane-${workspaceId}-panel-${tab.id}`}
            aria-labelledby={`pane-${workspaceId}-tab-${tab.id}`}
            aria-hidden={!active}
            className={`absolute inset-0 ${active ? 'visible z-10' : 'invisible z-0'}`}
            style={{ pointerEvents: active ? 'auto' : 'none' }}
          >
            <React.Suspense fallback={<SuspenseFallback label="Loading pane" />}>
              <PaneTabPanel
                workspaceId={workspaceId}
                tab={tab}
                onStartFuturePlan={onStartFuturePlan}
                onDiffCountChange={onDiffCountChange}
              />
            </React.Suspense>
          </div>
        )
      })}
    </>
  )
}
