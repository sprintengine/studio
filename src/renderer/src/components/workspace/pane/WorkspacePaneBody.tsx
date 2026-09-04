import React from 'react'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../types/workspace'
import type { FuturePlanWorkspaceSource } from '../../../types/workspace'
import { SuspenseFallback } from '../../ui/SuspenseFallback'
import { paneKindRetainsPanel } from './paneKinds'

// The pane's content region: one layer per tab that needs to stay mounted
// (terminal, later browser) plus the active tab. Inactive retained layers are
// `invisible` rather than `hidden` so xterm keeps its measured size and a tab
// switch never refits the buffer; everything else mounts only while showing.

const FileExplorer = React.lazy(() => import('../../panels/FileExplorer'))
const PlainTerminalPanel = React.lazy(() => import('../../panels/PlainTerminalPanel'))

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
}

function PaneTabPanel({ workspaceId, tab, onStartFuturePlan }: PaneTabPanelProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
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
    default:
      return <PaneUnavailable />
  }
}

type WorkspacePaneBodyProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  activeTabId: string | null
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

export function WorkspacePaneBody({ workspaceId, tabs, activeTabId, onStartFuturePlan }: WorkspacePaneBodyProps) {
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
              <PaneTabPanel workspaceId={workspaceId} tab={tab} onStartFuturePlan={onStartFuturePlan} />
            </React.Suspense>
          </div>
        )
      })}
    </>
  )
}
