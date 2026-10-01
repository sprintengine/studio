import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ConversationLaunchService } from '../conversation-launch-service'
import {
  capLaunchPermissionPreset,
  launchPermissionCeiling,
  type AgentPermissionResolver,
} from './launch-permission-cap'

/**
 * Starting a chat is a mutation: audited, and on the tailnet it needs
 * `conversation:operate` — the grant that already lets a paired device send
 * into, stop and approve this machine's chats (tailnet-scopes.ts maps the
 * `conversation.` family by this classification).
 */
export const CONVERSATION_MUTATION_TOOL_NAMES: readonly string[] = ['conversation.create']

export type ConversationToolsDeps = {
  launch: ConversationLaunchService['launch']
  /** The calling agent's own preset, which a chat it starts may not exceed (launch-permission-cap.ts). */
  resolveAgentPermissionPreset: AgentPermissionResolver
}

export function createConversationTools(deps: ConversationToolsDeps): McpToolRegistration[] {
  return [
    {
      name: 'conversation.create',
      description:
        'Start a chat agent in a workspace: the CLI runs as a conversation (the chat view, not a terminal). ' +
        'The chat is added to the workspace, its session is started, and `prompt` is sent as its first ' +
        'message; the call returns once the session is up, without waiting for the reply. Follow it with ' +
        'the conversation stream by its workspaceId and agentId.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
          newChat: {
            type: 'boolean',
            description:
              'Start a new chat of its own in the folder of workspaceId, rather than adding one to that ' +
              "workspace's chat. The new chat's workspaceId is returned; its first message titles it.",
          },
          cli: {
            type: 'string',
            description:
              'Agent CLI plugin id the chat drives; defaults to the last selected CLI. Only CLIs with a chat ' +
              'provider can start as a chat.',
          },
          cliModel: { type: 'string', description: "The CLI's model id; the CLI's own default when omitted." },
          permissionPreset: {
            type: 'string',
            enum: ['bypass', 'auto', 'manual', 'none'],
            description:
              'Tool permissions: "bypass" skips the CLI\'s prompts; "auto" runs the CLI\'s own auto mode, which ' +
              'runs what it judges safe; "manual" asks before every edit, command and outside call; "none" lets ' +
              "the CLI's configuration decide. Prompts surface as approvals. Omitted, the preset chosen for that " +
              'CLI on this machine, else "auto". ' +
              "Called by an agent of this app, the chat runs no looser than that agent's own preset: a looser " +
              'one is refused with "permission_escalation", and an omitted one takes the stricter of the two.',
          },
          prompt: { type: 'string', description: "The chat's first message." },
          name: { type: 'string', description: 'Agent display name; one from the name pool when omitted.' },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        for (const key of ['cli', 'cliModel', 'prompt', 'name', 'permissionPreset'] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'string') {
            return toolError('invalid_arguments', `"${key}" must be a string when provided.`)
          }
        }
        if (args.newChat !== undefined && typeof args.newChat !== 'boolean') {
          return toolError('invalid_arguments', '"newChat" must be a boolean when provided.')
        }
        const permissionPreset =
          args.permissionPreset === undefined ? undefined : parseCliPermissionPreset(args.permissionPreset)
        if (permissionPreset === null) {
          return toolError('invalid_arguments', '"permissionPreset" must be "bypass", "auto", "manual" or "none".')
        }
        const capped = capLaunchPermissionPreset(
          permissionPreset,
          launchPermissionCeiling(context, deps.resolveAgentPermissionPreset),
        )
        if ('refused' in capped) return toolError(capped.refused.code, capped.refused.message)
        const launched = await deps.launch({
          workspaceId: args.workspaceId.trim(),
          ...(args.newChat === true ? { newChat: true } : {}),
          ...(typeof args.cli === 'string' ? { cli: args.cli } : {}),
          ...(typeof args.cliModel === 'string' ? { cliModel: args.cliModel } : {}),
          ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
          ...(typeof args.name === 'string' ? { name: args.name } : {}),
          ...(capped.permissionPreset ? { permissionPreset: capped.permissionPreset } : {}),
        })
        if (!launched.ok) return toolError(launched.code, launched.message)
        return toolSuccess({
          conversation: {
            workspaceId: launched.workspaceId,
            agentId: launched.agentId,
            name: launched.name,
            cli: launched.cli,
            providerId: launched.providerId,
            modelId: launched.modelId,
            sessionId: launched.sessionId,
          },
        })
      },
    },
  ]
}
