import type { Workspace } from '../../types/workspace'
import { isSettledWorkspace } from '../../utils/workspaceSettle'

// What `chat.settle` does to the chat on screen, the same toggle as Settle in
// the row's menu: a settled chat comes back; one whose agents are working is
// left alone, because settling ends their processes and whatever they were
// doing with them; a chat opened from a paired machine asks that machine
// first; any other chat settles here.
export type ChatSettleStep = 'restore' | 'busy' | 'settle-remote' | 'settle'

export function chatSettleStep(
  workspace: Pick<Workspace, 'settledAt' | 'remoteOrigin'>,
  working: boolean,
): ChatSettleStep {
  if (isSettledWorkspace(workspace)) return 'restore'
  if (working) return 'busy'
  return workspace.remoteOrigin ? 'settle-remote' : 'settle'
}
