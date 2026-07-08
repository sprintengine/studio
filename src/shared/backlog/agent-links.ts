// The working-agent Backlog link shape, single-sourced for every writer: the
// renderer handoff (drag/drop, "send to agent"), Sprint Engine projection
// refresh, and the automation server's backlog.assign tool. Pure and
// node-free (tsconfig.web-safe). The renderer-only halves — resolving a link
// to a live agent and opening its terminal — stay in
// src/renderer/src/utils/agentBacklogLinks.ts.

// Owned by the always-on core module so agent links never go dark through
// module disablement.
export const AGENT_RUNTIME_MODULE_ID = 'agent-runtime'
export const AGENT_TERMINAL_TARGET_KIND = 'agent.terminal'
// Fixed per-item link id: the Backlog service upserts by link id, so re-handing
// an item to a different agent replaces the link (most-recent-agent-wins) rather
// than piling up stale agent links.
export const WORKING_AGENT_LINK_ID = 'agent-runtime:working-agent'

// The link target identity is workspaceId + agentId — the only durable
// navigation key (PTY/CLI session ids are reaped or change across relaunch).
// Both are opaque ids without '/' today; the encode/parse pair is the single
// place that knows the composite format.
export function encodeAgentLinkTargetId(workspaceId: string, agentId: string): string {
  return `${workspaceId}/${agentId}`
}

export function parseAgentLinkTargetId(
  targetId: string,
): { workspaceId: string; agentId: string } | null {
  const separator = targetId.indexOf('/')
  if (separator <= 0 || separator >= targetId.length - 1) return null
  const workspaceId = targetId.slice(0, separator)
  const agentId = targetId.slice(separator + 1)
  if (!workspaceId || !agentId || agentId.includes('/')) return null
  return { workspaceId, agentId }
}

const AGENT_LABEL_PREFIX = 'Agent: '

export function agentLinkLabel(agentName: string): string {
  return `${AGENT_LABEL_PREFIX}${agentName}`
}

// Recover a display name from a stored link without a store read — used as the
// tab-rename fallback when opening (the agent usually already has a tab).
export function agentNameFromLink(link: { label: string }): string {
  return link.label.startsWith(AGENT_LABEL_PREFIX)
    ? link.label.slice(AGENT_LABEL_PREFIX.length)
    : link.label
}

// Structural shape of the built link; assignable to both the renderer's
// BacklogItemLink and the main-process BacklogItemLinkPayload.
export type AgentBacklogLink = {
  id: string
  moduleId: string
  type: 'agent'
  label: string
  target: { kind: string; id: string }
  updatedAt: string
}

// The agent link recorded on a Backlog item when it is handed to an agent.
export function buildAgentBacklogLink(input: {
  workspaceId: string
  agentId: string
  agentName: string
}): AgentBacklogLink {
  return {
    id: WORKING_AGENT_LINK_ID,
    moduleId: AGENT_RUNTIME_MODULE_ID,
    type: 'agent',
    label: agentLinkLabel(input.agentName),
    target: {
      kind: AGENT_TERMINAL_TARGET_KIND,
      id: encodeAgentLinkTargetId(input.workspaceId, input.agentId),
    },
    updatedAt: new Date().toISOString(),
  }
}
