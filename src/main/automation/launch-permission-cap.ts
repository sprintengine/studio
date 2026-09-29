import {
  isLooserCliPermissionPreset,
  isMostPermissiveCliPermissionPreset,
  normalizeCliPermissionPreset,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from '../../shared/cli-permission-preset'
import { AGENT_BACKED_ACTION_KINDS, AUTOMATION_DEFAULT_PERMISSION_PRESET } from '../../shared/automations/contracts'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { isRecord } from '../../shared/records'

// An agent can only start an agent with the permissions it has itself (owner
// ruling 2026-09-29). Without this, one gateway call — `agent.launch` with
// `permissionPreset: "bypass"` — lets an agent the person deliberately runs on
// `none` hand any prompt to a fresh agent that never asks, and a prompt
// injection in a README is enough to make that call.
//
// Only a connection that declared itself one of this app's agents is capped.
// The person's own scripts (no identity) and paired tailnet devices (a proven
// device identity, gated by their scopes) keep launching on any preset, as the
// person can from the launcher.
//
// The threat model is the agent, not the machine. The identity is declared by
// the bridge from the agent's environment, and anything that can open the
// socket could declare another agent's — but writing raw frames to a socket
// needs a shell, and an agent on `none` asks the person before it runs one. So
// a capped agent cannot shed its cap by tool calls alone, which is the path
// this closes; a connection that has declared an agent cannot re-declare
// itself as another one or as none at all (mcp-dispatch.ts).

/**
 * The preset an agent is running on right now, or null when no live session or
 * agent record names it.
 */
export type AgentPermissionResolver = (agent: { workspaceId?: string; agentId: string }) => CliPermissionPreset | null

export type LaunchPermissionRefusal = { code: 'permission_escalation'; message: string }

/**
 * The loosest preset a launch this connection asks for may run on, or null
 * when the connection is not capped. An agent that names itself and cannot be
 * found is capped at `none`: failing open there would make "claim an id
 * nobody holds" the way out of the cap.
 */
export function launchPermissionCeiling(
  context: McpConnectionContext | undefined,
  resolve: AgentPermissionResolver,
): CliPermissionPreset | null {
  const metadata = context?.metadata
  if (metadata?.kind !== 'studio-agent' || !metadata.agentId) return null
  return (
    resolve({ agentId: metadata.agentId, ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}) }) ??
    'none'
  )
}

/**
 * The preset a gateway launch forwards under `ceiling`.
 *
 * A named preset at or below the ceiling goes through as named; a looser one
 * is refused rather than quietly lowered, so the caller learns its launch
 * would not have been what it asked for. An omitted preset is left to the
 * launch service, as before, when nothing could exceed the ceiling; otherwise
 * it is pinned to the ceiling, since the service's own default (the person's
 * choice for the CLI, else `bypass`) could be looser than the caller.
 */
export function capLaunchPermissionPreset(
  requested: CliPermissionPreset | undefined,
  ceiling: CliPermissionPreset | null,
): { permissionPreset: CliPermissionPreset | undefined } | { refused: LaunchPermissionRefusal } {
  if (ceiling === null) return { permissionPreset: requested }
  if (requested === undefined) {
    return { permissionPreset: isMostPermissiveCliPermissionPreset(ceiling) ? undefined : ceiling }
  }
  if (isLooserCliPermissionPreset(requested, ceiling)) return { refused: escalation(requested, ceiling) }
  return { permissionPreset: requested }
}

/**
 * An automation draft as an agent under `ceiling` may store it.
 *
 * An automation launches later, with nobody watching, so the preset it stores
 * is held to the same cap as a launch now. An agent-backed action that names
 * no preset would run on the automation default, `bypass`; under a stricter
 * ceiling the draft is given the ceiling explicitly. Any other action kind is
 * a provider's own code, which can start an agent on whatever preset it
 * chooses, so a capped agent may not create one at all.
 */
export function capAutomationDraft(
  definition: Record<string, unknown>,
  ceiling: CliPermissionPreset | null,
): { definition: Record<string, unknown> } | { refused: LaunchPermissionRefusal } {
  if (ceiling === null || isMostPermissiveCliPermissionPreset(ceiling)) return { definition }
  const action = isRecord(definition.action) ? definition.action : null
  const kind = typeof action?.kind === 'string' ? action.kind : null
  if (!action || !kind || !AGENT_BACKED_ACTION_KINDS.includes(kind)) return { refused: unboundedAction(kind, ceiling) }
  const config = isRecord(action.config) ? action.config : {}
  const stored = automationActionPreset(config)
  // An unreadable preset launches nothing (spawn-agent refuses it at run time),
  // and one at or below the ceiling is the caller's to choose.
  if (!stored || !isLooserCliPermissionPreset(stored, ceiling)) return { definition }
  if (namedActionPreset(config) !== undefined) return { refused: escalation(stored, ceiling) }
  return { definition: { ...definition, action: { ...action, config: { ...config, permissionPreset: ceiling } } } }
}

/**
 * Whether an agent under `ceiling` may run a stored automation now: refused
 * when the run would launch looser than the caller, or when its action is not
 * one of the app's own and so could launch on anything.
 */
export function refuseAutomationRun(
  definition: { action: { kind: string; config: unknown } },
  ceiling: CliPermissionPreset | null,
): LaunchPermissionRefusal | null {
  if (ceiling === null || isMostPermissiveCliPermissionPreset(ceiling)) return null
  const { kind, config } = definition.action
  if (!AGENT_BACKED_ACTION_KINDS.includes(kind)) return unboundedAction(kind, ceiling)
  const stored = automationActionPreset(isRecord(config) ? config : {})
  // Unreadable: the run fails in spawn-agent before it launches anything.
  if (!stored) return null
  return isLooserCliPermissionPreset(stored, ceiling) ? escalation(stored, ceiling) : null
}

// The preset an agent-backed action launches on, read exactly as spawn-agent
// reads it: a blank or non-string value is no value, and takes the automation
// default. Null when the value is not a preset, which spawn-agent refuses.
function automationActionPreset(config: Record<string, unknown>): CliPermissionPreset | null {
  const named = namedActionPreset(config)
  return named === undefined ? AUTOMATION_DEFAULT_PERMISSION_PRESET : parseCliPermissionPreset(named)
}

function namedActionPreset(config: Record<string, unknown>): string | undefined {
  const value = config.permissionPreset
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function escalation(requested: CliPermissionPreset, ceiling: CliPermissionPreset): LaunchPermissionRefusal {
  return {
    code: 'permission_escalation',
    message:
      `This agent runs on the "${ceiling}" permission preset, so it may only launch agents at that level or ` +
      `stricter; "${requested}" would give the new agent permissions its launcher does not have. Omit ` +
      `"permissionPreset" or pass "${ceiling}".`,
  }
}

function unboundedAction(kind: string | null, ceiling: CliPermissionPreset): LaunchPermissionRefusal {
  return {
    code: 'permission_escalation',
    message:
      `This agent runs on the "${ceiling}" permission preset, so it may only launch agents at that level or ` +
      `stricter. ${kind ? `The "${kind}" action` : 'An action without a kind'} can start an agent on any ` +
      `preset, so only ${AGENT_BACKED_ACTION_KINDS.join(' and ')} automations are open to it.`,
  }
}

/**
 * The live preset of the agent behind a gateway connection, from main's own
 * state.
 *
 * A running chat answers first: its preset can change mid-conversation, and
 * the runtime records a change only once the provider has applied it. Then a
 * live terminal that main launched, whose launch record is the preset rendered
 * into its command line. Last the agent's record in the workspace, which is
 * what a window spawned its terminal agent with — read as the window reads it,
 * so an old record with no preset is the `bypass` it was launched on. When one
 * id matches more than one session, the strictest wins.
 */
export function createAgentPermissionResolver(deps: {
  listConversationSessions(agentId: string): ReadonlyArray<{
    workspaceId: string
    agentId: string
    status: string
    permissionPreset?: string
  }>
  listTerminalSessions(): ReadonlyArray<{
    kind?: string
    workspaceId?: string
    agentId?: string
    processAlive: boolean
    agentRecord?: { cliPermissionPreset?: unknown }
  }>
  readAgentRecordPreset(workspaceId: string, agentId: string): { found: false } | { found: true; preset: unknown }
}): AgentPermissionResolver {
  return ({ workspaceId, agentId }) => {
    const sameWorkspace = (candidate: string | undefined): boolean => !workspaceId || candidate === workspaceId

    const chats = deps
      .listConversationSessions(agentId)
      .filter((session) => session.agentId === agentId && sameWorkspace(session.workspaceId))
      .filter((session) => session.status !== 'stopped')
    // A running chat that never chose a preset runs on its provider's default,
    // which is to ask.
    if (chats.length > 0) return strictest(chats.map((session) => parseCliPermissionPreset(session.permissionPreset)))

    const terminals = deps
      .listTerminalSessions()
      .filter(
        (session) =>
          session.kind === 'agent' &&
          session.processAlive &&
          session.agentId === agentId &&
          sameWorkspace(session.workspaceId) &&
          session.agentRecord !== undefined,
      )
    if (terminals.length > 0) {
      return strictest(terminals.map((session) => parseCliPermissionPreset(session.agentRecord?.cliPermissionPreset)))
    }

    if (!workspaceId) return null
    const record = deps.readAgentRecordPreset(workspaceId, agentId)
    return record.found ? normalizeCliPermissionPreset(record.preset) : null
  }
}

// Unreadable counts as `none`: a session whose preset cannot be read is not
// evidence that it may do more.
function strictest(presets: ReadonlyArray<CliPermissionPreset | null>): CliPermissionPreset {
  let lowest: CliPermissionPreset | undefined
  for (const preset of presets) {
    const read = preset ?? 'none'
    if (lowest === undefined || isLooserCliPermissionPreset(lowest, read)) lowest = read
  }
  return lowest ?? 'none'
}
