import type {
  ConversationWirePermissionPreset,
  StudioCreatedConversation,
} from '../../../packages/studio-protocol/src/public'
import type { AgentState } from '../../shared/agent-state'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import type {
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationSessionActionResult,
  ConversationStopSessionInput,
} from '../../shared/conversation-runtime'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../shared/launch-settings'
import type { StudioConversationBackend } from '../../server/rpc/studio-rpc-types'
import type { ConversationGatewayHost } from '../automation/tailnet/tailnet-conversation-host'
import { redactConversationValue } from '../conversation-tool-details'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'

// The conversations the Studio RPC serves, in main: the conversation host the
// tailnet lane wraps (list, follow, reads and commands, with its session
// resume and catalog checks), the launch service a module's and a paired
// machine's New chat go through, and the runtime for stop. One chat behaves
// the same whichever door it is reached by.

export type StudioConversationBackendDeps = {
  host: ConversationGatewayHost
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
  listSessions: (input?: ConversationListSessionsInput) => ConversationListSessionsResult
  stopSession: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  /** Every workspace with its agent records, read fresh on each call. */
  getWorkspaceAgents: () => ReadonlyArray<{ id: string; agents: Record<string, AgentState> }>
}

export function createStudioConversationBackend(deps: StudioConversationBackendDeps): StudioConversationBackend {
  const { host } = deps
  const liveSessions = (key: { workspaceId: string; agentId: string }) => {
    const listed = deps.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
    return listed.ok ? listed.sessions.filter((session) => session.status !== 'stopped') : []
  }
  return {
    list: () => host.list(),
    resolveKey: (workspaceId, agentId) => host.resolveKey(workspaceId, agentId),
    follow: (key, cursor, listener) => host.subscribe(key, cursor, listener),
    loadEarlier: (key, beforeCursor, turnLimit) => host.loadEarlier(key, beforeCursor, turnLimit),
    toolDetail: (key, toolUseId) => host.getToolDetail(key, toolUseId),
    turnDiff: (key, turnSeq, path) => host.getTurnDiff(key, turnSeq, path),
    command: (key, clientId, commandId, command) => host.command(key, clientId, commandId, command),
    async stop(key) {
      for (const session of liveSessions(key)) {
        const stopped = await deps.stopSession({ sessionId: session.sessionId })
        if (!stopped.ok) return { ok: false, message: stopped.message }
      }
      return { ok: true }
    },
    // How loose the chat runs, for a ceiling: its preset, except that a
    // session started with tools it may use unasked runs those tools as
    // `bypass` would, and so counts as `bypass`.
    permissionOf: (key) =>
      liveSessions(key).some((session) => session.allowsUnaskedTools)
        ? 'bypass'
        : ((host.permissionOf?.(key) ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET) as ConversationWirePermissionPreset),
    findCreated(launchCommandId) {
      for (const workspace of deps.getWorkspaceAgents()) {
        for (const agent of Object.values(workspace.agents)) {
          if (agent?.launchCommandId !== launchCommandId || agent.runtimeKind !== 'conversation') continue
          const live = liveSessions({ workspaceId: workspace.id, agentId: agent.id }).sort(
            (a, b) => b.createdAt - a.createdAt,
          )[0]
          const providerId = live?.providerId ?? agent.conversation?.providerId ?? ''
          const preset = live?.permissionPreset ?? agent.cliPermissionPreset
          return {
            workspaceId: workspace.id,
            agentId: agent.id,
            sessionId: live?.sessionId ?? null,
            name: agent.name,
            cli: cliForConversationProvider(providerId) ?? providerId,
            providerId,
            modelId: live?.modelId ?? agent.conversation?.modelId ?? '',
            ...(preset ? { permissionPreset: preset } : {}),
          } satisfies StudioCreatedConversation
        }
      }
      return null
    },
    async create(request, launchCommandId) {
      const launched = await deps.launch({
        workspaceId: request.workspaceId,
        ...(request.cli ? { cli: request.cli } : {}),
        ...(request.model ? { cliModel: request.model } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.skills?.length ? { skills: request.skills } : {}),
        ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
        ...(request.permissionPreset && request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        ...(request.allowedTools?.length ? { allowedTools: request.allowedTools } : {}),
        launchCommandId,
      })
      if (!launched.ok) return { ok: false, code: launched.code, message: launched.message }
      const record = deps.getWorkspaceAgents().find((workspace) => workspace.id === launched.workspaceId)?.agents[
        launched.agentId
      ]
      const preset = record?.cliPermissionPreset ?? request.permissionPreset
      return {
        ok: true,
        conversation: {
          workspaceId: launched.workspaceId,
          agentId: launched.agentId,
          sessionId: launched.sessionId,
          name: launched.name,
          cli: launched.cli,
          providerId: launched.providerId,
          modelId: launched.modelId,
          ...(preset ? { permissionPreset: preset } : {}),
          ...(preset && record?.cliPermissionMode ? { permissionMode: record.cliPermissionMode } : {}),
        },
      }
    },
    // The tailnet lane's redaction of secret-shaped members, for events, pages,
    // tool details and diffs alike. Paths stay as they are, because a client on
    // this machine reads this machine's files; the tailnet lane rewrites them
    // for a reader elsewhere.
    redact: (value) => redactConversationValue(value),
  }
}
