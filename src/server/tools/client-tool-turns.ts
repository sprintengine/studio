import type { ClientToolRegistry } from './client-tool-registry'

// A turn that ended without finishing (interrupted from the chat's stop, from
// `conversation.interrupt`, or failed), and a session that closed, are
// answered for: a call they were waiting on in a client is cancelled there,
// and the agent answered `cancelled`, whether or not the agent's CLI cancels
// its own MCP request. A turn that completed waited for every call it made.

/** The conversation events after which nothing waits on a client tool any more. */
const ENDS = new Set(['turn_failed', 'session_closed'])

export function cancelClientCallsAtTurnEnd(
  registry: Pick<ClientToolRegistry, 'cancelCallsFor'>,
  event: { type: string; workspaceId?: string; agentId?: string },
): number {
  if (!ENDS.has(event.type) || !event.workspaceId || !event.agentId) return 0
  return registry.cancelCallsFor({ workspaceId: event.workspaceId, agentId: event.agentId })
}
