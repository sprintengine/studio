import type { BacklogItem, BacklogItemLink, BacklogResolvedLink } from './backlog'
import { findWorkspaceForAgentPreferring } from './agentLocation'
import type { BacklogLinkProviderInput } from '../modules/renderer-host'
import type { Workspace } from '../types/workspace'

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
export function agentNameFromLink(link: BacklogItemLink): string {
  return link.label.startsWith(AGENT_LABEL_PREFIX)
    ? link.label.slice(AGENT_LABEL_PREFIX.length)
    : link.label
}

// The agent link recorded on a Backlog item when it is handed to an agent.
export function buildAgentBacklogLink(input: {
  workspaceId: string
  agentId: string
  agentName: string
}): BacklogItemLink {
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

export function agentLinkForItem(item: Pick<BacklogItem, 'links'>): BacklogItemLink | null {
  return item.links.find((link) =>
    link.moduleId === AGENT_RUNTIME_MODULE_ID
    && link.type === 'agent'
    && link.target.kind === AGENT_TERMINAL_TARGET_KIND,
  ) ?? null
}

export function hasAgentLink(item: Pick<BacklogItem, 'links'>): boolean {
  return Boolean(agentLinkForItem(item))
}

function unavailableLink(link: BacklogItemLink, reason: string): BacklogResolvedLink {
  return { ...link, status: 'unknown', unavailableReason: reason, canOpen: false }
}

// Resolve is navigational, never lifecycle: it only ever reports `active`
// (agent reachable) or `unknown` (not). It never emits completed/failed, so an
// `agent`-typed link can never move item status (the status rule filters
// `execution` only) — completion authority stays with the Backlog skill/status.
export function resolveAgentBacklogLink(
  input: BacklogLinkProviderInput & {
    workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'agents'>>
  },
): BacklogResolvedLink {
  const parsed = parseAgentLinkTargetId(input.link.target.id)
  if (!parsed) {
    return unavailableLink(input.link, 'Agent link target is malformed.')
  }
  // Resolve to the live agent, preferring the workspace the link was recorded in.
  // Agent ids are not globally unique (a bare `agent-1` recurs in every
  // template-built workspace), so the stored workspace is what disambiguates the
  // hit; the global scan is only a fallback for a genuinely-moved agent.
  if (!findWorkspaceForAgentPreferring(input.workspaces, parsed.agentId, parsed.workspaceId)) {
    return unavailableLink(input.link, 'This agent is no longer open.')
  }
  return { ...input.link, status: 'active', canOpen: true }
}

export type AgentBacklogLinkOpenPorts = {
  // Activate the agent's workspace and focus (or add) its terminal tab. The
  // workspace is resolved live, preferring `preferredWorkspaceId` (the workspace
  // the link was recorded in) so a shared id like `agent-1` lands on the right
  // workspace, with a global scan as the moved-agent fallback. Returns false when
  // the agent is not open anywhere so the caller can surface a diagnostic. The
  // port owns the workspace lookup and the mounted-model vs persisted-layout
  // fallback.
  focusAgent(input: {
    agentId: string
    agentName: string
    preferredWorkspaceId?: string
  }): boolean | Promise<boolean>
  publishDiagnostic?(input: {
    level: 'info' | 'warning' | 'error'
    source: string
    title: string
    message: string
    details?: string
    workspaceId?: string
  }): Promise<unknown> | unknown
}

export async function openAgentBacklogLink(
  input: BacklogLinkProviderInput & { ports: AgentBacklogLinkOpenPorts },
): Promise<boolean> {
  const parsed = parseAgentLinkTargetId(input.link.target.id)
  if (!parsed) {
    await input.ports.publishDiagnostic?.({
      level: 'warning',
      source: 'workspace',
      title: 'Agent unavailable',
      message: 'This Backlog link does not point at a valid agent.',
      workspaceId: input.workspaceId,
    })
    return false
  }

  const focused = await input.ports.focusAgent({
    agentId: parsed.agentId,
    agentName: agentNameFromLink(input.link),
    preferredWorkspaceId: parsed.workspaceId,
  })
  if (!focused) {
    await input.ports.publishDiagnostic?.({
      level: 'warning',
      source: 'workspace',
      title: 'Agent unavailable',
      message: 'Could not open the agent terminal for this Backlog item — it may have been closed.',
      details: parsed.agentId,
      workspaceId: input.workspaceId,
    })
    return false
  }
  return true
}
