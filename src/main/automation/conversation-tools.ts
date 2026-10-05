import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
} from '../../shared/modules/mcp-tools'
import type { WorkspaceRegistryActor } from '../../shared/workspace-registry'
import type { ConversationLifecycle } from './conversation-lifecycle'
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
 * `conversation.` family by this classification). Settling one and saying it
 * was looked at write the desktop's own record of the chat, so they need the
 * same grant.
 */
export const CONVERSATION_MUTATION_TOOL_NAMES: readonly string[] = [
  'conversation.create',
  'conversation.settle',
  'conversation.visit',
]

export type ConversationToolsDeps = {
  launch: ConversationLaunchService['launch']
  /** The calling agent's own preset, which a chat it starts may not exceed (launch-permission-cap.ts). */
  resolveAgentPermissionPreset: AgentPermissionResolver
  /** A chat's rest and visit clock, written to the desktop's own record (conversation-lifecycle.ts). */
  lifecycle: Pick<ConversationLifecycle, 'settle' | 'visit'>
}

/**
 * Who a lifecycle write came through, for the registry's record of it: a
 * paired device over the tailnet, or the local socket's own callers.
 */
function lifecycleActor(context: McpConnectionContext | undefined): WorkspaceRegistryActor {
  return context?.metadata.kind === 'remote-tailnet' ? 'mobile' : 'gateway'
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
    {
      name: 'conversation.settle',
      description:
        "Settle a chat on this machine, as its row menu's Settle does: it leaves the chat list, its agents' " +
        'processes end, and the next message to it resumes it. With settled: false it is brought back, and ' +
        'held out of the automatic settle until it sees new activity. Refused with "working" while an agent ' +
        'in the chat is working. Settling a chat already settled, or bringing back one that is not, changes ' +
        'nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          settled: { type: 'boolean', description: 'false brings a settled chat back. Defaults to true.' },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (args.settled !== undefined && typeof args.settled !== 'boolean') {
          return toolError('invalid_arguments', '"settled" must be a boolean when provided.')
        }
        const settled = deps.lifecycle.settle(args.workspaceId.trim(), args.settled !== false, lifecycleActor(context))
        if (!settled.ok) return toolError(settled.code, settled.message)
        return toolSuccess(settled)
      },
    },
    {
      name: 'conversation.visit',
      description:
        'Say that a person has a chat on this machine on screen, so its "finished, unseen" mark clears on ' +
        "every device. Moves the chat's lastVisitedAt forward to visitedAt (now when omitted, and never past " +
        'now); an earlier time changes nothing. It is not activity: the chat keeps its place in the list and ' +
        'a settled chat stays settled.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          visitedAt: {
            type: 'number',
            description: 'When the person had it on screen, in epoch milliseconds. Defaults to now.',
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (
          args.visitedAt !== undefined &&
          !(typeof args.visitedAt === 'number' && Number.isFinite(args.visitedAt) && args.visitedAt >= 0)
        ) {
          return toolError('invalid_arguments', '"visitedAt" must be a time in epoch milliseconds when provided.')
        }
        const visited = deps.lifecycle.visit(
          args.workspaceId.trim(),
          args.visitedAt as number | undefined,
          lifecycleActor(context),
        )
        if (!visited.ok) return toolError(visited.code, visited.message)
        return toolSuccess(visited)
      },
    },
  ]
}
