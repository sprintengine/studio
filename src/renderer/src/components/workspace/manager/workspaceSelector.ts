// The workspace store selector WorkspaceManager renders from, and the
// equality check that keeps it from re-rendering on fields it never reads.

import type { Workspace } from '../../../types/workspace'

export type WorkspaceManagerWorkspaceCacheEntry = {
  source: Workspace
  value: Workspace
}

export const workspaceManagerWorkspaceCache = new Map<string, WorkspaceManagerWorkspaceCacheEntry>()

export function workspaceManagerWorkspaceFieldsEqual(left: Workspace, right: Workspace): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mode === right.mode &&
    left.folderPath === right.folderPath &&
    left.folderMissing === right.folderMissing &&
    left.templateId === right.templateId &&
    left.layoutModel === right.layoutModel &&
    left.worktreeState === right.worktreeState &&
    left.memory === right.memory &&
    left.editorState === right.editorState &&
    left.fileExplorerState === right.fileExplorerState &&
    left.moduleState === right.moduleState &&
    left.highlight === right.highlight &&
    left.createdAt === right.createdAt &&
    left.lastTerminalActivityAt === right.lastTerminalActivityAt &&
    // The sidebar's ordering key: without it a chat kept its old place until
    // some unrelated field moved the projection along.
    left.lastUserMessageAt === right.lastUserMessageAt &&
    left.lastTurnEndedAt === right.lastTurnEndedAt &&
    // Rest (settled-chats, 2026-09-07): a Settle or Un-settle changes only
    // these, and the sidebar renders from this projection — without them the
    // row stayed where it was until something unrelated moved.
    left.settledAt === right.settledAt &&
    left.settledOverride === right.settledOverride &&
    // The pane column: open/closed, its tabs, the tab showing. Without it the
    // projection handed back the cached workspace when the pane opened, so a
    // value derived from `paneState` off this projection (the pane-open flag
    // the card's right edge used to gate on) kept what it had at first render
    // until an unrelated field moved.
    left.paneState === right.paneState
  )
}

export function selectWorkspaceManagerWorkspaces(workspaces: Workspace[]): Workspace[] {
  const liveIds = new Set<string>()
  const selected = workspaces.map((workspace) => {
    liveIds.add(workspace.id)
    const cached = workspaceManagerWorkspaceCache.get(workspace.id)
    if (cached && workspaceManagerWorkspaceFieldsEqual(cached.source, workspace)) {
      return cached.value
    }
    workspaceManagerWorkspaceCache.set(workspace.id, { source: workspace, value: workspace })
    return workspace
  })

  for (const workspaceId of workspaceManagerWorkspaceCache.keys()) {
    if (!liveIds.has(workspaceId)) workspaceManagerWorkspaceCache.delete(workspaceId)
  }

  return selected
}
