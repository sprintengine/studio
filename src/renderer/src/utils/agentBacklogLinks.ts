import type { BacklogItem, BacklogItemLink, BacklogResolvedLink } from './backlog'
import { findWorkspaceForAgentPreferring } from './agentLocation'
import type { BacklogLinkProviderInput } from '../modules/renderer-host'
import type { Workspace } from '../types/workspace'

// The link shape itself (constants, target-id codec, label, builder) is
// single-sourced in the shared module so the main-process automation server
// (backlog.assign) builds byte-identical links; this file keeps the
// renderer-only halves: resolving a link against live workspaces and opening
// the agent terminal.
export {
  AGENT_RUNTIME_MODULE_ID,
  AGENT_TERMINAL_TARGET_KIND,
  WORKING_AGENT_LINK_ID,
  agentNameFromLink,
  buildAgentBacklogLink,
  encodeAgentLinkTargetId,
  parseAgentLinkTargetId,
} from '../../../shared/backlog/agent-links'
import {
  AGENT_RUNTIME_MODULE_ID,
  AGENT_TERMINAL_TARGET_KIND,
  agentNameFromLink,
  parseAgentLinkTargetId,
} from '../../../shared/backlog/agent-links'

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
