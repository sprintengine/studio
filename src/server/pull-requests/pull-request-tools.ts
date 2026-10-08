import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { gatewayConversation } from '../tools/client-tool-gateway'
import type { NoteOpenedOutcome, PullRequestConversationKey } from './pull-request-record'

// The gateway's pull request tool: how an agent says "I opened this" (owner
// ruling 2026-10-04). The server notices the common create commands on its own
// (`src/shared/git/pull-request-opened.ts`); this is the way for every other
// forge and every other way of opening one, and it costs nothing to call after
// those too.
//
// Whose pull request it is comes from the CONNECTION, never from the
// arguments: the calling agent's workspace and agent, as the launch token the
// connection presented proves them. A connection that only declared an agent
// (the person's own scripts, a paired device, anything that can reach the
// socket) is not a conversation, and is refused.

/** Linking records a pull request against a conversation: a mutation, audited. */
export const PULL_REQUEST_LINK_TOOL = 'pull_request.link'

export type PullRequestToolsDeps = {
  link(key: PullRequestConversationKey, input: { url: string; title?: string }): Promise<NoteOpenedOutcome>
}

export function createPullRequestTools(deps: PullRequestToolsDeps): McpToolRegistration[] {
  return [
    {
      name: PULL_REQUEST_LINK_TOOL,
      description:
        "Record a pull request or merge request you just opened as this conversation's, so SprintEngine Studio " +
        'shows it on the conversation and follows it until it merges. Call this right after you create one, on any ' +
        'forge (GitHub, GitLab, Gitea, Forgejo, Codeberg, Bitbucket, Azure DevOps, self-hosted or not), with the URL ' +
        'the forge gave you. Link only what you opened: one another conversation linked first stays with it. ' +
        'Studio notices `gh pr create` and `glab mr create` on its own, and linking after those is harmless.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              "The pull request's web URL, e.g. https://github.com/acme/app/pull/12 or " +
              'https://gitlab.com/acme/app/-/merge_requests/12.',
          },
          title: { type: 'string', description: "Its title, shown until the forge's own is read." },
        },
        required: ['url'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        // The conversation the connection's launch token proved, not the ids
        // it declared: any local connection can declare an agent id, and a
        // link written under one would put a server or a pull request on
        // somebody else's conversation.
        const conversation = gatewayConversation(context)
        if (!conversation) {
          return toolError(
            'not_a_conversation',
            'Only an agent SprintEngine Studio started can link a pull request: it is recorded as that ' +
              "agent's conversation's.",
          )
        }
        if (typeof args.url !== 'string' || !args.url.trim() || args.url.length > 2048) {
          return toolError('invalid_arguments', '"url" is the pull request\'s web URL.')
        }
        if (args.title !== undefined && typeof args.title !== 'string') {
          return toolError('invalid_arguments', '"title" must be a string when provided.')
        }
        const outcome = await deps.link(
          { workspaceId: conversation.workspaceId, agentId: conversation.agentId },
          { url: args.url.trim(), ...(typeof args.title === 'string' ? { title: args.title } : {}) },
        )
        if (!outcome.ok) return toolError(outcome.code, outcome.message)
        const { pullRequest } = outcome
        return toolSuccess({
          linked: true,
          alreadyLinked: !outcome.recorded,
          pullRequest: {
            url: pullRequest.url,
            number: pullRequest.number,
            repository: pullRequest.repoKey,
            forge: pullRequest.forge ?? 'github',
            // Read from GitHub; a pull request on another forge is shown as opened.
            ...(pullRequest.forge ? {} : { state: pullRequest.state }),
          },
        })
      },
    },
  ]
}
