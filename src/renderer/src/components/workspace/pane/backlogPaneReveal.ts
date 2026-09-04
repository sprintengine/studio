import { useWorkspaceStore } from '../../../store/workspaceStore'
import { dispatchBacklogReveal } from '../../../utils/backlogReveal'

/**
 * The one way another surface lands a person on a Backlog item: open or
 * focus the workspace pane's Backlog tab, THEN latch the reveal. The order
 * matters — the panel is often cold when the request comes (the tab closed,
 * or behind another), so it mounts a tick later and drains the latch on
 * mount; a panel already showing takes the live event instead. With no
 * path the tab simply opens.
 */
export function revealBacklogItemInPane(workspaceId: string, relativePath?: string | null): void {
  useWorkspaceStore.getState().openPaneTab(workspaceId, { kind: 'backlog' })
  if (relativePath) dispatchBacklogReveal({ workspaceId, relativePath })
}
