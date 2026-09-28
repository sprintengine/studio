/**
 * ConversationLaunchService — starting a chat agent is a main-process
 * capability, as starting a terminal agent is (`agent-launch-service.ts`).
 *
 * A window starts a chat by adding a conversation-runtime agent to its store
 * and letting the chat view start the session and send the first message. That
 * needs a window showing the chat. A paired machine asking this one to start a
 * chat over the tailnet has no window here to lean on, so the same three steps
 * run in main:
 *
 * 1. The agent record is written to the workspace registry, so every window
 *    here lists the chat and a later-opened one shows it with its history.
 * 2. The conversation session is started, on the CLI's chat provider.
 * 3. The prompt is sent as the chat's first message. The send is NOT awaited:
 *    the runtime answers a send when the whole turn has finished, and the
 *    caller is a person waiting on a pane that follows the turn live.
 *
 * A session that cannot start takes its record back out, so a refused launch
 * never leaves a chat nobody can open.
 */
import { randomUUID } from 'crypto'

import { pickRandomAgentName } from '../shared/agent-names'
import { defaultAgent, type AgentState } from '../shared/agent-state'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../shared/conversation-harness'
import type {
  ConversationCliRuntimeOverrides,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
} from '../shared/conversation-runtime'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import {
  effectiveAgentLaunchSettings,
  resolveAgentSpawnPermissionPreset,
  type AgentLaunchSettings,
} from '../shared/launch-settings'

/** A workspace as the chat launch needs to see it. */
export type ConversationLaunchWorkspace = {
  id: string
  folderPath?: string | null
  agents?: Record<string, { name?: string }>
}

export type ConversationLaunchRequest = {
  workspaceId: string
  /** The agent CLI the chat drives; the last-selected CLI when absent. */
  cli?: string
  /** The CLI's model id; the CLI's own default when absent. */
  cliModel?: string
  /** Absent, the preset chosen for that CLI here, else the app default — as the launcher would. */
  permissionPreset?: CliPermissionPreset
  /** The chat's first message. */
  prompt?: string
  name?: string
}

export type ConversationLaunchResult =
  | {
      ok: true
      workspaceId: string
      agentId: string
      name: string
      cli: string
      providerId: string
      modelId: string
      sessionId: string
    }
  | { ok: false; code: string; message: string }

export type ConversationLaunchServiceDeps = {
  getWorkspace: (workspaceId: string) => ConversationLaunchWorkspace | null
  /** Read at launch time, never cached, as the terminal launch reads it. */
  getLaunchSettings: () => AgentLaunchSettings
  /** Write (or, with null, remove) an agent record through the sequenced workspace bus. */
  writeAgent: (workspaceId: string, agentId: string, agent: AgentState | null) => { ok: boolean; message?: string }
  startSession: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  send: (input: { sessionId: string; commandId: string; message: string }) => Promise<ConversationSessionActionResult>
  /** Where a first message the runtime refused is reported; the chat itself shows a failed turn. */
  warn?: (message: string) => void
  /** Agent id suffix. Injected so tests get stable ids. */
  newAgentSuffix?: () => string
  newCommandId?: () => string
}

export type ConversationLaunchService = {
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
}

export function createConversationLaunchService(deps: ConversationLaunchServiceDeps): ConversationLaunchService {
  const newAgentSuffix = deps.newAgentSuffix ?? (() => randomUUID().replace(/-/g, '').slice(0, 6))
  const newCommandId = deps.newCommandId ?? (() => randomUUID())

  async function launch(request: ConversationLaunchRequest): Promise<ConversationLaunchResult> {
    const workspace = deps.getWorkspace(request.workspaceId)
    if (!workspace) {
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${request.workspaceId}" is not known to the running app.`,
      }
    }
    const workspaceRoot = workspace.folderPath?.trim()
    if (!workspaceRoot) {
      return {
        ok: false,
        code: 'workspace_folder_missing',
        message: `Workspace "${workspace.id}" has no project folder, so there is nowhere to start the chat.`,
      }
    }

    const settings = effectiveAgentLaunchSettings(deps.getLaunchSettings())
    const cli = request.cli?.trim() || settings.lastSelectedCli || ''
    if (!cli) {
      return { ok: false, code: 'no_cli_selected', message: 'No CLI was requested and no last-selected CLI is set.' }
    }
    // Never another CLI in its place: the caller picked this one on its own
    // launcher, and a chat on a different CLI would not be what it showed.
    const providerId = conversationProviderForCli(cli)
    if (!providerId) {
      return {
        ok: false,
        code: 'cli_not_conversational',
        message: `"${cli}" cannot run as a chat agent here. Pick another CLI, or start it as a terminal agent.`,
      }
    }
    const modelId = request.cliModel?.trim() || CONVERSATION_DEFAULT_MODEL_ID
    const permissionPreset = resolveAgentSpawnPermissionPreset(settings, cli, request.permissionPreset)

    const agentId = `agent-${cli}-${newAgentSuffix()}`
    const name =
      request.name?.trim() ||
      pickRandomAgentName(
        Object.values(workspace.agents ?? {})
          .map((agent) => agent?.name)
          .filter((taken): taken is string => Boolean(taken)),
      )
    // The same record a window's New chat writes (`conversationNewChatSeed`),
    // minus the startup prompt: that field asks a mounting chat view to send
    // it, and here main sends it itself.
    const agent: AgentState = {
      ...defaultAgent(agentId, name),
      runtimeKind: 'conversation',
      conversation: { providerId, modelId },
      cliPermissionPreset: permissionPreset,
    }
    const written = deps.writeAgent(workspace.id, agentId, agent)
    if (!written.ok) {
      return {
        ok: false,
        code: 'agent_write_failed',
        message: written.message ?? `The chat could not be added to workspace "${workspace.id}".`,
      }
    }

    const started = await deps
      .startSession({
        workspaceRoot,
        workspaceId: workspace.id,
        agentId,
        providerId,
        modelId,
        // The person's command overrides, as a window's chat passes them.
        ...(Object.keys(settings.cliRuntimes ?? {}).length > 0
          ? { cliRuntimes: settings.cliRuntimes as ConversationCliRuntimeOverrides }
          : {}),
        permissionPreset,
      })
      .catch((error: unknown): ConversationStartSessionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The conversation could not start.',
      }))
    if (!started.ok) {
      deps.writeAgent(workspace.id, agentId, null)
      return { ok: false, code: 'conversation_start_failed', message: started.message }
    }

    const prompt = request.prompt?.trim()
    if (prompt) {
      const sessionId = started.session.sessionId
      void deps
        .send({ sessionId, commandId: newCommandId(), message: prompt })
        .then((sent) => {
          if (!sent.ok) deps.warn?.(`The first message of chat "${agentId}" was refused: ${sent.message}`)
        })
        .catch((error: unknown) => {
          deps.warn?.(
            `The first message of chat "${agentId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }

    return {
      ok: true,
      workspaceId: workspace.id,
      agentId,
      name,
      cli,
      providerId,
      modelId,
      sessionId: started.session.sessionId,
    }
  }

  return { launch }
}
