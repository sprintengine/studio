import React, { useEffect } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspaceId } from '../../../types/workspace'
import { WorkspaceAsideColumn } from '../workspaceAsideColumn'
import WorkspacePane from './WorkspacePane'
import { openUrlInPane } from './browser/openInPane'
import { OFFSCREEN_LAYER_STYLE } from './WorkspacePaneBody'

// The pane column (browser-pane epic): the full-height column on the shell
// row's right edge, beside the WorkspaceHeader, that hosts every retained
// workspace's pane. One is visible — the active workspace's — and the others
// stay mounted invisibly, the same retention the workspace layers use, so a
// pane terminal (later a browser page) survives a workspace switch. Width is
// app-level; open/closed is the active workspace's own flag.

type WorkspacePaneColumnProps = {
  activeWorkspaceId: WorkspaceId | null
  // The workspaces whose layers are mounted right now (WorkspaceManager's
  // retention set); a pane mounts for each that has tabs, plus the active one.
  renderedWorkspaceIds: readonly WorkspaceId[]
}

export function WorkspacePaneColumn({
  activeWorkspaceId,
  renderedWorkspaceIds,
}: WorkspacePaneColumnProps) {
  const width = useWorkspaceStore((s) => s.workspacePaneWidth)
  const setWidth = useWorkspaceStore((s) => s.setWorkspacePaneWidth)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const activeOpen = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.paneState?.open ?? false,
  )
  // A floating player paints outside the column, so a collapsed column must
  // stay interactive for it (WorkspaceAsideColumn.keepInteractive); the pane
  // marks its own clipped chrome inert instead.
  const activeFloating = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.paneState?.tabs.some((tab) => tab.floating) ?? false,
  )
  // Ids with something to keep alive: a workspace with no tabs has nothing to
  // retain and mounts only while it is the active one.
  const mountedIds = useWorkspaceStore((s) =>
    renderedWorkspaceIds
      .filter((id) => id === activeWorkspaceId || (s.workspaces.find((w) => w.id === id)?.paneState?.tabs.length ?? 0) > 0)
      .join('\n'),
  )
  const ids = mountedIds ? mountedIds.split('\n') : []

  // browser.open from an agent: the window SHOWING that workspace answers —
  // opens the tab, shows the pane — so the person sees what the agent is
  // about to do. A window that merely retains the workspace off screen stays
  // out of it, so no orphan tabs appear in a second window; with no window
  // showing it, the tool reports that honestly.
  useEffect(
    () =>
      window.api.onBrowserOpenRequest(({ workspaceId, url, tabId }) => {
        if (workspaceId !== activeWorkspaceId) return
        const store = useWorkspaceStore.getState()
        const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
        // A floating tab is already in view. Re-opening the pane on top of it
        // would put the same page on screen twice and take back the width the
        // person floated it to reclaim.
        const floatingTabId = pane?.tabs.find((tab) => tab.floating)?.id ?? null
        if (tabId) {
          if (tabId === floatingTabId) return
          // The agent navigated an existing tab: bring it to the front.
          if (pane?.tabs.some((tab) => tab.id === tabId)) store.setActivePaneTab(workspaceId, tabId)
        } else if (url) {
          if (!openUrlInPane(workspaceId, url, { forceNewTab: true })) return
        } else if (!pane?.tabs.some((tab) => tab.kind === 'browser')) {
          store.openPaneTab(workspaceId, { kind: 'browser' })
        }
        store.setPaneOpen(workspaceId, true)
      }),
    [activeWorkspaceId],
  )

  return (
    <WorkspaceAsideColumn
      label="Workspace pane"
      width={width}
      onWidthChange={setWidth}
      collapsed={!activeOpen}
      keepInteractive={activeFloating}
      fill={activeOpen && maximised}
    >
      {ids.map((workspaceId) => {
        const active = workspaceId === activeWorkspaceId
        return (
          <div
            key={workspaceId}
            // Inactive panes park offscreen rather than `invisible`: a browser
            // guest under visibility:hidden blanks for good on macOS
            // (WorkspacePaneBody.OFFSCREEN_LAYER_STYLE).
            // No stacking tier: every layer but the active one is offscreen,
            // so nothing can paint over the front pane.
            className="absolute inset-0"
            style={active ? { pointerEvents: 'auto' } : OFFSCREEN_LAYER_STYLE}
            aria-hidden={!active}
            {...(active ? {} : ({ inert: '' } as Record<string, string>))}
          >
            <WorkspacePane workspaceId={workspaceId} active={active} />
          </div>
        )
      })}
    </WorkspaceAsideColumn>
  )
}
