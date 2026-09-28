import type { Workspace, WorkspaceId } from '../../types/workspace'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { isSettledWorkspace } from '../../utils/workspaceSettle'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { folderDisplayName, remoteGroupDisplayName, remoteGroupOf } from '../workspace/sidebar/folderGroups'
import { remoteConversationTitle } from '../workspace/remoteBand/remoteSessionsModel'

// Settings ▸ Settled chats reads the same record the sidebar's Settled shelf
// did (`settledAt`) — there is no second store of old chats, only a second
// place to look at the one there is.

export type SettledChatEntry = {
  id: WorkspaceId
  /** The row title the sidebar would have drawn. */
  title: string
  /** The project the sidebar would have filed it under. */
  project: string
  settledAt: number
}

/**
 * Every settled chat the rail would draw, most recently settled first: the
 * question someone opening this page is asking is "the one I put away the
 * other day", not "the oldest thing I own". Rail-hidden hosts (the
 * Automations workspace, module-hidden workspaces) stay out here for the same
 * reason they are out of the rail — they were never chats.
 */
export function listSettledChats(
  workspaces: readonly Workspace[],
  moduleOverrides?: ModuleEnablementOverrides,
): SettledChatEntry[] {
  const entries: SettledChatEntry[] = []
  for (const workspace of workspaces) {
    if (!isSettledWorkspace(workspace) || isHiddenFromRail(workspace, moduleOverrides)) continue
    entries.push({
      id: workspace.id,
      title: remoteConversationTitle(workspace),
      project: remoteGroupOf(workspace) ? remoteGroupDisplayName(workspace) : folderDisplayName(workspace.folderPath),
      settledAt: workspace.settledAt as number,
    })
  }
  return entries.sort((a, b) => b.settledAt - a.settledAt)
}
