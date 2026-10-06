import type { LayoutTemplate } from '../renderer/src/types/workspace'
import type { AgentId } from './agent-state'

// Agent ids used to be unique only within their workspace: the layout templates
// name their agents `agent-1` … `agent-9`, and every chat built from one took
// those names verbatim, so nearly every chat's first agent was `agent-1`. Code
// that matched an agent by id across workspaces then reached another chat's
// agent (and killed its process). An id minted here is unique across every
// workspace, so a new chat never shares an id with another one. Chats made
// before keep their ids: their transcripts, checkpoints and links are all filed
// under the pair (workspace id, agent id), and renaming would orphan them.

// Lower case and digits only: the id names files (`<agentId>.jsonl`, its
// `.tools` folder) on file systems that ignore case, where two ids differing
// only in case would share a file.
const SUFFIX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
// 36^16 is about 2^82: no two agents will draw the same suffix. The six hex
// characters this replaced (2^24) were a birthday-paradox risk across every
// agent a long-lived install ever starts.
const SUFFIX_LENGTH = 16

/** The random tail of a minted agent id. */
export function newAgentIdSuffix(): string {
  let suffix = ''
  // A byte above the largest multiple of the alphabet's size is drawn again,
  // so every character is equally likely.
  const limit = 256 - (256 % SUFFIX_ALPHABET.length)
  while (suffix.length < SUFFIX_LENGTH) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH * 2))) {
      if (byte >= limit) continue
      suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]
      if (suffix.length === SUFFIX_LENGTH) break
    }
  }
  return suffix
}

/**
 * A new agent id, unique across every workspace: `agent-<cli>-<suffix>` when the
 * CLI is known, as the agents a chat adds later have always been named, and
 * `agent-<suffix>` for a template's agent, whose CLI is not chosen yet.
 */
export function newAgentId(cli?: string | null): AgentId {
  const named = cli?.trim()
  return named ? `agent-${named}-${newAgentIdSuffix()}` : `agent-${newAgentIdSuffix()}`
}

// A minted id ends in a whole suffix: `agent-` then the suffix, or `agent-`,
// the CLI and `-` then the suffix. Every other id an agent has had ends in
// something shorter: the template positions (`agent-1`), the six-character tail
// agents a chat added used to get (`agent-codex-3fa9c1`, or a nanoid(6) that may
// itself hold a `-`), and a module's own keys (`forecaster`, `worker-1`).
const MINTED_AGENT_ID = new RegExp(`^agent-(?:.+-)?[${SUFFIX_ALPHABET}]{${SUFFIX_LENGTH}}$`)

/**
 * Whether `agentId` was minted here, and so names one agent across every
 * workspace. Only such an id may be followed out of the workspace it was
 * recorded in: any other is shared by agents of other chats, and finding it
 * somewhere else finds a namesake, not the agent.
 */
export function isMintedAgentId(agentId: string): boolean {
  return MINTED_AGENT_ID.test(agentId)
}

type LayoutJson = LayoutTemplate['layout']
type LayoutNodeJson = { component?: unknown; config?: unknown; children?: unknown }

/**
 * Turn a template's layout into one a new workspace can own: every agent the
 * template names (a tab's `config.agentId`) takes a fresh id, and every place
 * the layout names that agent follows it. Returns the new layout, a clone (the
 * template is shared and never changed), and `agentIds`, each template id
 * mapped to the id that replaced it, in the order the layout lists them.
 *
 * `assign` names the id a template agent takes when the caller already holds
 * one (a chat main starts mints its agent before its workspace); the rest are
 * minted. Every path that makes a workspace from a template goes through here,
 * so the window's create, main's headless create and main's new chat cannot
 * disagree on what a template agent is called.
 */
export function instantiateTemplateAgentIds(
  layout: LayoutJson,
  options: { assign?: Readonly<Record<AgentId, AgentId>>; mint?: () => AgentId } = {},
): { layout: LayoutJson; agentIds: Record<AgentId, AgentId> } {
  const mint = options.mint ?? (() => newAgentId())
  const next = structuredClone(layout)
  const agentIds: Record<AgentId, AgentId> = {}
  const nodes: LayoutNodeJson[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const json = node as LayoutNodeJson
    nodes.push(json)
    if (Array.isArray(json.children)) json.children.forEach(walk)
  }
  walk(next.layout)
  next.borders?.forEach(walk)

  // The agent tabs say which ids are the template's agents; mapping only those
  // leaves any other component's config alone.
  for (const node of nodes) {
    const agentId = configAgentId(node)
    if (node.component !== 'agent' || !agentId || Object.hasOwn(agentIds, agentId)) continue
    const assigned = options.assign?.[agentId]?.trim()
    agentIds[agentId] = assigned || mint()
  }
  for (const node of nodes) {
    const agentId = configAgentId(node)
    if (agentId && Object.hasOwn(agentIds, agentId)) {
      ;(node.config as Record<string, unknown>).agentId = agentIds[agentId]
    }
  }
  return { layout: next, agentIds }
}

function configAgentId(node: LayoutNodeJson): string | null {
  const config = node.config
  if (!config || typeof config !== 'object') return null
  const agentId = (config as { agentId?: unknown }).agentId
  return typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null
}
