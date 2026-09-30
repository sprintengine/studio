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
 *
 * A workspace here is one chat, and its name is the chat's title. So a caller
 * that means "a new chat in this project" — a phone's or a paired machine's
 * New chat, which names a project by one of the workspaces in its folder —
 * asks for `newChat`: the chat is then born in a workspace of its own, in that
 * workspace's folder, instead of joining the chat that workspace already is.
 * A refused start then takes that whole workspace back out.
 *
 * The same three steps start every chat main starts for someone else: a module's
 * `create`, and an automation run's agent. Those callers add what a window's
 * New chat also carries — skills installed before the session starts and
 * attached to the first message, pictures on it — plus what only they need: the
 * module that owns the chat, and a run worktree the chat works in instead of
 * the workspace checkout.
 */
import { randomUUID } from 'crypto'

import { pickRandomAgentName } from '../shared/agent-names'
import { defaultAgent, type AgentState } from '../shared/agent-state'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../shared/conversation-harness'
import type {
  ConversationCliRuntimeOverrides,
  ConversationImageAttachment,
  ConversationMcpServer,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
} from '../shared/conversation-runtime'
import type { EnsureSkillInstalledResult } from '../shared/modules/skills'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import type { ExecutionHostId } from '../shared/execution-host'
import { resolveConnectorLaunchFrom } from '../shared/connector-launch'
import { conversationCliRuntimesForHost } from '../shared/conversation-cli-runtimes'
import type { McpServerConfig } from '../shared/ipc/mcp'
import { SOLO_CHAT_AGENT_ID, SOLO_CHAT_TEMPLATE_ID } from '../shared/layouts/templates'
import { deriveWorkspaceTitle, nextNewChatName } from '../shared/workspace-title'
import type { WorkspaceWorktree } from '../renderer/src/types/workspace'
import type { WorkspaceCreateRequest } from './workspace-registry-service'
import {
  effectiveAgentLaunchSettings,
  resolveAgentSpawnPermissionPreset,
  type AgentLaunchSettings,
} from '../shared/launch-settings'

/** A workspace as the chat launch needs to see it. */
export type ConversationLaunchWorkspace = {
  id: string
  name?: string
  folderPath?: string | null
  hostId?: ExecutionHostId | null
  worktree?: WorkspaceWorktree | null
  agents?: Record<string, { name?: string }>
}

export type ConversationLaunchRequest = {
  /** The workspace the chat joins (or, with `newChat`, whose folder a new one starts in). */
  workspaceId?: string
  /**
   * Start the chat in a new workspace of its own in this folder, on this
   * machine, with no workspace to borrow them from: a scheduled agent's run.
   * Takes the place of `workspaceId` and implies `newChat`.
   */
  newChatIn?: {
    folderPath: string
    hostId?: ExecutionHostId | null
    worktree?: WorkspaceWorktree | null
  }
  /**
   * Start the chat in a new workspace of its own, in `workspaceId`'s folder
   * (on its machine, and marked as the same worktree), rather than in that
   * workspace. The new workspace takes an app-minted name, so the chat's
   * first message titles it.
   */
  newChat?: boolean
  /** The agent CLI the chat drives; the last-selected CLI when absent. */
  cli?: string
  /** The CLI's model id; the CLI's own default when absent. */
  cliModel?: string
  /** Absent, the preset chosen for that CLI here, else the app default — as the launcher would. */
  permissionPreset?: CliPermissionPreset
  /** The chat's first message. */
  prompt?: string
  name?: string
  /**
   * Skill ids installed into the chat's working root before its session
   * starts, attached to the first message and kept on the chat as its skill
   * chips. An id no skill answers to refuses the launch (`unknown_skill`).
   */
  skills?: string[]
  /** Pictures sent with the first message. */
  attachments?: ConversationImageAttachment[]
  /** The module that started the chat; only that module reaches it through the module service. */
  ownerModuleId?: string
  /**
   * The scheduled agent whose run this is. Written on the workspace a new
   * chat is born in (`Workspace.scheduledAgentId`), so the chat says where it
   * came from; a chat joining a workspace that already exists is not a run,
   * and the field is ignored there.
   */
  scheduledAgentId?: string
  /**
   * The folder the chat works in instead of the workspace checkout: an
   * automation run's worktree. The chat still lives in the workspace.
   */
  worktreePath?: string
  /**
   * The installed MCP server (a connector) the chat runs with, on top of the
   * person's own configuration: an automation that runs with a connector.
   * Resolved as a terminal connector launch resolves it; one that is not
   * installed and enabled refuses the launch (`connector_unavailable`), and a
   * CLI whose chats take no MCP servers of their own refuses the start.
   */
  connectorId?: string
  /** More installed MCP servers the chat runs with, each resolved and refused as `connectorId` is. */
  connectorIds?: string[]
  /**
   * Send `prompt` as the first message (the default). False starts the session
   * and sends nothing, for a caller that sends the first turn itself.
   */
  sendFirst?: boolean
  /**
   * Told when the first message was refused or failed. The launch has already
   * answered by then, so this is the only way a caller waiting on the chat's
   * first turn learns that none is coming.
   */
  onFirstSendFailed?: (message: string) => void
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
  /** Every workspace, for the name a `newChat` takes beside the others in its folder. */
  listWorkspaces: () => ConversationLaunchWorkspace[]
  /** Create a workspace through the sequenced workspace bus, as a headless create does. */
  createWorkspace: (
    request: WorkspaceCreateRequest,
  ) => { ok: true; workspaceId: string } | { ok: false; message: string }
  removeWorkspace: (workspaceId: string) => void
  startSession: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  send: (
    input: Pick<ConversationSendTurnInput, 'sessionId' | 'commandId' | 'message' | 'skills' | 'attachments'>,
  ) => Promise<ConversationSessionActionResult>
  /**
   * Make a skill present in the chat's working root, as a terminal launch does
   * (`ensureSkillInstalled`). Absent, requested skills are left to the
   * runtime's own resolver at the first send, and no id is refused up front.
   */
  ensureSkillInstalled?: (workingRoot: string, skillId: string) => Promise<EnsureSkillInstalledResult>
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
    // A chat born in a folder has no workspace to read the folder, machine and
    // worktree off, so it stands in for one that has no agents yet.
    const newChat = request.newChat === true || request.newChatIn !== undefined
    const workspace: ConversationLaunchWorkspace | null = request.newChatIn
      ? {
          id: '',
          folderPath: request.newChatIn.folderPath,
          hostId: request.newChatIn.hostId ?? null,
          worktree: request.newChatIn.worktree ?? null,
          agents: {},
        }
      : request.workspaceId
        ? deps.getWorkspace(request.workspaceId)
        : null
    if (!workspace) {
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${request.workspaceId ?? ''}" is not known to the running app.`,
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
    // Never a chat that silently runs without a connector it was asked for.
    const connectorIds = [
      ...new Set([request.connectorId, ...(request.connectorIds ?? [])].map((id) => id?.trim()).filter(Boolean)),
    ] as string[]
    const mcpServers: ConversationMcpServer[] = []
    for (const connectorId of connectorIds) {
      const connector = resolveConnectorLaunchFrom({ connectorId, installedServers: settings.mcp?.servers })
      if (!connector.ok) return { ok: false, code: 'connector_unavailable', message: connector.message }
      mcpServers.push(...Object.values(connector.resolved.mcpSettings.servers).map(conversationMcpServer))
    }
    const modelId = request.cliModel?.trim() || CONVERSATION_DEFAULT_MODEL_ID
    const permissionPreset = resolveAgentSpawnPermissionPreset(settings, cli, request.permissionPreset)
    // The run worktree when there is one: the session starts there, so the
    // agent's edits, its transcript and the skills below all stay inside it.
    const worktreePath = request.worktreePath?.trim() || undefined
    const workingRoot = worktreePath ?? workspaceRoot

    // Skills first, before anything is written: an id nothing answers to is
    // the caller's mistake and refuses the launch, where a copy that could not
    // be written is only reported — the runtime installs a missing skill again
    // when the first message attaches it.
    const skills = [...new Set((request.skills ?? []).map((id) => id.trim()).filter(Boolean))]
    if (deps.ensureSkillInstalled) {
      for (const skillId of skills) {
        const installed = await deps
          .ensureSkillInstalled(workingRoot, skillId)
          .catch((error: unknown): EnsureSkillInstalledResult => ({
            ok: false,
            status: 'install-failed',
            message: error instanceof Error ? error.message : String(error),
          }))
        if (installed.ok) continue
        if (installed.status === 'unknown-skill') {
          return { ok: false, code: 'unknown_skill', message: `No skill "${skillId}" is available to attach.` }
        }
        deps.warn?.(
          `Skill "${skillId}" could not be installed for a chat in "${workspace.id}": ${installed.message ?? installed.status}`,
        )
      }
    }

    // A new chat's agent is its workspace's one template tab, as a window's
    // New chat makes it; one joining a workspace takes an id of its own.
    const agentId = newChat ? SOLO_CHAT_AGENT_ID : `agent-${cli}-${newAgentSuffix()}`
    const name =
      request.name?.trim() ||
      pickRandomAgentName(
        newChat
          ? []
          : Object.values(workspace.agents ?? {})
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
      // Where a window's chat view finds the session: a worktree chat is keyed
      // by the worktree, not the workspace folder (`conversationWorkingRoot`).
      ...(worktreePath ? { execution: { mode: 'worktree' as const, worktreeId: null, cwd: worktreePath } } : {}),
      ...(skills.length > 0 ? { conversationSkills: skills } : {}),
      ...(request.ownerModuleId?.trim() ? { ownerModuleId: request.ownerModuleId.trim() } : {}),
    }
    let chatWorkspaceId = workspace.id
    if (newChat) {
      // Named after the message it is about to be sent, as a window names a chat
      // after its first prompt. Only a window titles a chat, and a chat started
      // here (from a phone, a paired machine, a schedule) may have no window
      // showing it, so without this it kept "Chat N" everywhere, the phone
      // included. The name stays open: a window's model-written title still
      // replaces it when one is on.
      const firstTitle = request.sendFirst !== false && request.prompt ? deriveWorkspaceTitle(request.prompt) : null
      // Born with its agent, in one event, so a window never shows the
      // template's tab with no agent behind it.
      const created = deps.createWorkspace({
        name:
          firstTitle ??
          nextNewChatName(
            deps
              .listWorkspaces()
              .filter((other) => other.folderPath === workspace.folderPath)
              .map((other) => other.name ?? ''),
          ),
        ...(firstTitle ? { titleOpen: true } : {}),
        folderPath: workspace.folderPath,
        templateId: SOLO_CHAT_TEMPLATE_ID,
        ...(workspace.hostId ? { hostId: workspace.hostId } : {}),
        ...(workspace.worktree ? { worktree: workspace.worktree } : {}),
        ...(request.scheduledAgentId?.trim() ? { scheduledAgentId: request.scheduledAgentId.trim() } : {}),
        agents: { [agentId]: agent },
      })
      if (!created.ok) return { ok: false, code: 'workspace_create_failed', message: created.message }
      chatWorkspaceId = created.workspaceId
    } else {
      const written = deps.writeAgent(workspace.id, agentId, agent)
      if (!written.ok) {
        return {
          ok: false,
          code: 'agent_write_failed',
          message: written.message ?? `The chat could not be added to workspace "${workspace.id}".`,
        }
      }
    }

    // The chat's CLI on the machine the chat runs on: a WSL workspace's Claude
    // chat runs that distribution's `claude`, as a window's chat would.
    const cliRuntimes = conversationCliRuntimesForHost(settings.cliRuntimes, workspace.hostId, settings.hosts)
    const started = await deps
      .startSession({
        workspaceRoot: workingRoot,
        workspaceId: chatWorkspaceId,
        agentId,
        providerId,
        modelId,
        // The person's command overrides, as a window's chat passes them.
        ...(Object.keys(cliRuntimes ?? {}).length > 0
          ? { cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides }
          : {}),
        permissionPreset,
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
      })
      .catch((error: unknown): ConversationStartSessionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The conversation could not start.',
      }))
    if (!started.ok) {
      if (newChat) deps.removeWorkspace(chatWorkspaceId)
      else deps.writeAgent(workspace.id, agentId, null)
      return { ok: false, code: 'conversation_start_failed', message: started.message }
    }

    const prompt = request.prompt?.trim()
    if (prompt && request.sendFirst !== false) {
      const sessionId = started.session.sessionId
      const failed = (message: string): void => {
        deps.warn?.(message)
        request.onFirstSendFailed?.(message)
      }
      void deps
        .send({
          sessionId,
          commandId: newCommandId(),
          message: prompt,
          ...(skills.length > 0 ? { skills: skills.map((id) => ({ id })) } : {}),
          ...(request.attachments?.length ? { attachments: request.attachments } : {}),
        })
        .then((sent) => {
          if (!sent.ok) failed(`The first message of chat "${agentId}" was refused: ${sent.message}`)
        })
        .catch((error: unknown) => {
          failed(
            `The first message of chat "${agentId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }

    return {
      ok: true,
      workspaceId: chatWorkspaceId,
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

// An installed server as a session takes it: what the CLI needs to start or
// reach it, without the settings-only fields.
function conversationMcpServer(server: McpServerConfig): ConversationMcpServer {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    ...(server.envVarNames?.length ? { envVarNames: server.envVarNames } : {}),
  }
}
