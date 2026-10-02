// A replay asked for from outside the chat — its tab's menu — reaches the chat
// view here. The ask is held until the view takes it, because the menu selects
// the tab first and a tab never shown before mounts its chat only then.

const pending = new Set<string>()
const listeners = new Set<() => void>()

function keyOf(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`
}

/** Ask the chat `agentId` in `workspaceId` to start a replay. */
export function requestChatReplay(workspaceId: string, agentId: string): void {
  pending.add(keyOf(workspaceId, agentId))
  for (const listener of listeners) listener()
}

/** Whether a replay was asked of this chat; taking it answers the ask. */
export function takeChatReplayRequest(workspaceId: string, agentId: string): boolean {
  return pending.delete(keyOf(workspaceId, agentId))
}

/** Hear every ask; returns the unsubscribe. */
export function onChatReplayRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
