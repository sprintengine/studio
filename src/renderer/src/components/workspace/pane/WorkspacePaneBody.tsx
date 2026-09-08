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
const BrowserTab = React.lazy(() =>
  import('./browser/BrowserTab').then((module) => ({ default: module.BrowserTab })),
)

// An inactive layer is normally `invisible`; a browser layer is parked
// offscreen instead. Electron blanks a `visibility:hidden` guest for good on
// macOS, and a guest fully outside the window stops compositing without
// losing its page. Parking is the only hiding a browser layer survives.
export const OFFSCREEN_LAYER_STYLE: React.CSSProperties = {
  visibility: 'visible',
  transform: 'translateX(-100000px)',
  pointerEvents: 'none',
}

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
  active: boolean
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  onDiffCountChange?: (count: number | null) => void
}

function PaneTabPanel({ workspaceId, tab, active, onStartFuturePlan, onDiffCountChange }: PaneTabPanelProps) {
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
    case 'backlog': {
      // The workspace's Backlog panel, registered by backlog-module.ts. It
      // takes the same props the FlexLayout rail handed it, future plans
      // included.
      const BacklogPanel = getRendererHost().getPanel('backlog')
      return BacklogPanel && selectModuleEnabled(moduleOverrides, 'backlog')
        ? <BacklogPanel workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />
        : <PaneUnavailable />
    }
    case 'terminal':
      return tab.terminalId
        ? <PlainTerminalPanel workspaceId={workspaceId} terminalId={tab.terminalId} />
        : <PaneUnavailable />
    case 'browser':
      return <BrowserTab workspaceId={workspaceId} tab={tab} active={active} />
    case 'diff': {
      // The opener's repository wins: the Git panel can be showing a worktree
      // scope that is not the workspace's own checkout, and re-deriving one
      // here opened the tab on a different repository than the row came from.
      // The derived root is the fallback for a Diff tab opened from the pane's
      // own + menu, which names no repository at all.
      const repoRoot = tab.diff?.repoRoot ?? diffRepoRoot
      return repoRoot && selectModuleEnabled(moduleOverrides, 'git')
        ? (
          <DiffViewer
            // Keyed on the repo only: a Git row click retargets the mounted
            // viewer through its focus props. Remounting per target (the aux
            // window's rule) disposes Monaco's models under the diff widget.
            key={repoRoot}
            repoRoot={repoRoot}
            focusPath={tab.diff?.focusPath ?? null}
            focusKind={tab.diff?.focusKind ?? null}
            variant="pane"
            onItemCountChange={onDiffCountChange}
            // The pane is the only host with a branch to step through; the aux
            // window opens on one file of the working tree.
            branchSteps
          />
        )
        : <PaneUnavailable />
    }
    default:
      return <PaneUnavailable />
  }
}

type WorkspacePaneBodyProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  /** The tab whose panel is on screen: null when the pane is collapsed or the workspace is not the visible one. */
  activeTabId: string | null
  /** The tab the strip has selected, visible or not; decides which panel is the front one. */
  selectedTabId: string | null
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  onDiffCountChange?: (count: number | null) => void
}

export function WorkspacePaneBody({
  workspaceId,
  tabs,
  activeTabId,
  selectedTabId,
  onStartFuturePlan,
  onDiffCountChange,
}: WorkspacePaneBodyProps) {
  return (
    <>
      {tabs.map((tab) => {
        const selected = tab.id === selectedTabId
        const active = selected && tab.id === activeTabId
        if (!selected && !paneKindRetainsPanel(tab.kind)) return null
        const offscreen = !selected && tab.kind === 'browser'
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`pane-${workspaceId}-panel-${tab.id}`}
            aria-labelledby={`pane-${workspaceId}-tab-${tab.id}`}
            aria-hidden={!selected}
            // No stacking tier: an unselected panel is offscreen (browser) or
            // invisible (terminal), so the selected one is the only paint.
            className={`absolute inset-0 ${selected ? 'visible' : offscreen ? '' : 'invisible'}`}
            style={offscreen ? OFFSCREEN_LAYER_STYLE : { pointerEvents: selected ? 'auto' : 'none' }}
            // An offscreen layer is still in the DOM: `inert` keeps its address
            // field and buttons out of the tab order (the invisible ones are
            // unfocusable already).
            {...(offscreen ? ({ inert: '' } as Record<string, string>) : {})}
          >
            <React.Suspense fallback={<SuspenseFallback label="Loading pane" />}>
              <PaneTabPanel
                workspaceId={workspaceId}
                tab={tab}
                active={active}
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
