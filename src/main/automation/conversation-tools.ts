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

const EFFORT_ID = /^[a-z0-9_-]{1,40}$/i

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
          worktree: {
            type: 'boolean',
            description:
              'With newChat, start the new chat in a git worktree of its own, cut the way New chat on this ' +
              "machine cuts one with Worktree on: from this machine's worktree pool, on the project's default " +
              'branch, as a branch `agent/chat-<id>`; the chat is listed under the project it was cut from. A ' +
              'project that is not a git repository (or a folder on an SSH machine) is refused with ' +
              '"worktree_unavailable", never started in the checkout. Omitted or false, the chat works in the ' +
              "project's own folder.",
          },
          cli: {
            type: 'string',
            description:
              'Agent CLI plugin id the chat drives; defaults to the last selected CLI. Only CLIs with a chat ' +
              'provider can start as a chat.',
          },
          cliModel: { type: 'string', description: "The CLI's model id; the CLI's own default when omitted." },
          effort: {
            type: 'string',
            description:
              "The reasoning effort the chat runs at: one of the CLI's `reasoningLevels` (cli.runtime.list); " +
              'another is refused with "unsupported_effort". The chat keeps it as New chat here keeps its ' +
              "effort pick, and every turn runs at it where the CLI's chat runtime takes that level: Claude Code " +
              "and Codex do (Codex's chat runs low to xhigh; a higher level runs at its default). A CLI that " +
              "declares no levels (Cursor, OpenCode, Grok) ignores it. Omitted, the CLI's own default.",
          },
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
        for (const key of ['cli', 'cliModel', 'prompt', 'name', 'permissionPreset', 'effort'] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'string') {
            return toolError('invalid_arguments', `"${key}" must be a string when provided.`)
          }
        }
        for (const key of ['newChat', 'worktree'] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'boolean') {
            return toolError('invalid_arguments', `"${key}" must be a boolean when provided.`)
          }
        }
        // A worktree is where a new chat is born; a chat joining a workspace
        // works in that workspace's folder, which already is what it is.
        if (args.worktree === true && args.newChat !== true) {
          return toolError('invalid_arguments', '"worktree" starts a new chat in a worktree: set "newChat" with it.')
        }
        // The same shape a window's turn may name an effort in
        // (conversation-ipc-inputs.ts); whether the CLI has the level is the
        // launch's to say.
        if (typeof args.effort === 'string' && !EFFORT_ID.test(args.effort.trim())) {
          return toolError('invalid_arguments', '"effort" must be an effort level id, such as "high".')
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
          ...(args.worktree === true ? { newWorktree: true } : {}),
          ...(typeof args.effort === 'string' ? { reasoningEffort: args.effort.trim() } : {}),
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
