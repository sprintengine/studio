import type { Workspace, WorkspaceId } from '../../../types/workspace'
import { isSettledWorkspace } from '../../../utils/workspaceSettle'
import { isSnoozedWorkspace } from '../../../utils/workspaceSnooze'

// The attribute the sidebar's chat tree carries (`WorkspaceSidebar`), so the
// window can read its rows in the order they are drawn.
const WORKSPACE_TREE_ATTRIBUTE = 'data-workspace-tree'

/**
 * The chat ids of the sidebar's rows, top to bottom, as they are drawn — or
 * null when this document has no sidebar tree to read. A collapsed sidebar
 * keeps its rows in the DOM, so this still answers while it is hidden.
 */
export function drawnSidebarChatIds(root: ParentNode): WorkspaceId[] | null {
  const tree = root.querySelector(`[${WORKSPACE_TREE_ATTRIBUTE}]`)
  if (!tree) return null
  const ids: WorkspaceId[] = []
  for (const row of tree.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]')) {
    const id = row.dataset.workspaceId
    if (id) ids.push(id as WorkspaceId)
  }
  return ids
}

/**
 * The chats Primary+1…9 reach, in order — and the order Primary+` and
 * Primary+Shift+` step through, from the chat on screen (`keep`). The number keys follow the rail as
 * the person sees it — Starred first, then each project's chats by last
 * message, with a collapsed project's rows skipped — so "the third chat" is
 * the third row on screen. Rows on a Settled or Snoozed shelf are passed over,
 * as the hand-off after a Settle passes over them: a number key is for a chat
 * that is still going. A row drawn twice counts once.
 *
 * `drawn` is null when there is no sidebar to read; the store order of the
 * rail's chats stands in, with the resting and sleeping ones left out.
 */
export function numberedChatIds(
  drawn: readonly WorkspaceId[] | null,
  workspaces: readonly Workspace[],
  now: number,
  /** Kept even if it rests: the chat on screen, which a step goes on from. */
  keep: WorkspaceId | null = null,
): WorkspaceId[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const candidates = drawn ?? workspaces.map((workspace) => workspace.id)
  const seen = new Set<WorkspaceId>()
  const ids: WorkspaceId[] = []
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    const workspace = byId.get(id)
    if (!workspace) continue
    if (id !== keep && (isSettledWorkspace(workspace) || isSnoozedWorkspace(workspace, now))) continue
    ids.push(id)
  }
  return ids
}
