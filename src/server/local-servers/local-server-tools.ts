import { isAbsolute } from 'node:path'

import {
  STUDIO_LOCAL_SERVER_MAX_COMMAND,
  STUDIO_LOCAL_SERVER_MAX_TITLE,
  STUDIO_LOCAL_SERVER_MAX_URL,
} from '../../../packages/studio-protocol/src/public'
import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { LocalServerLinkOutcome } from './local-server-domain'
import { readLocalServerUrl, type LocalServerConversationKey, type LocalServerLinkInput } from './local-server-record'

// The gateway's local server tool: how an agent says "I started this server"
// (owner ruling 2026-10-04), so the person sees it on the conversation, can
// open it, and can run it again once it has stopped.
//
// Whose server it is comes from the CONNECTION, never from the arguments: the
// calling agent's workspace and agent, which the gateway knows from the
// agent's launch. Anything else calling (the person's own scripts, a paired
// device) is not a conversation, and is refused.

/** Linking records a server against a conversation: a mutation, audited. */
export const LOCAL_SERVER_LINK_TOOL = 'local_server.link'

export type LocalServerToolsDeps = {
  link(key: LocalServerConversationKey, input: LocalServerLinkInput): Promise<LocalServerLinkOutcome>
}

export function createLocalServerTools(deps: LocalServerToolsDeps): McpToolRegistration[] {
  return [
    {
      name: LOCAL_SERVER_LINK_TOOL,
      description:
        "Record a local server you just started as this conversation's, so SprintEngine Studio shows it on the " +
        'conversation with whether it is running, and the person can open it. Call this right after you start a ' +
        'dev server, a preview, or any local web server the person may want to open (on localhost, a LAN address ' +
        'or a tailnet address). Pass the command that starts it and the folder it runs in, so the person can run ' +
        'it again after it stops. Linking the same address again updates it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The address to open, e.g. http://localhost:5173/ or http://192.168.1.20:3000/.',
          },
          title: { type: 'string', description: 'A short name for it, e.g. "Web app (Vite)".' },
          command: {
            type: 'string',
            description: 'The shell command that starts it, e.g. "npm run dev". What "Run again" runs.',
          },
          cwd: {
            type: 'string',
            description: "The absolute folder the command runs in. Defaults to this conversation's folder.",
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const metadata = context?.metadata
        if (metadata?.kind !== 'studio-agent' || !metadata.workspaceId || !metadata.agentId) {
          return toolError(
            'not_a_conversation',
            'Only an agent SprintEngine Studio started can link a local server: it is recorded as that ' +
              "agent's conversation's.",
          )
        }
        // The unspecified address a dev server prints (`0.0.0.0`, `[::]`) is
        // recorded as `localhost`, which a browser can open.
        const address =
          typeof args.url === 'string' && args.url.length <= STUDIO_LOCAL_SERVER_MAX_URL
            ? readLocalServerUrl(args.url)
            : null
        if (!address) {
          return toolError('invalid_arguments', '"url" is the server\'s http or https address, with a host.')
        }
        if (
          args.title !== undefined &&
          (typeof args.title !== 'string' || args.title.length > STUDIO_LOCAL_SERVER_MAX_TITLE)
        ) {
          return toolError(
            'invalid_arguments',
            `"title" must be a string of at most ${STUDIO_LOCAL_SERVER_MAX_TITLE} characters when provided.`,
          )
        }
        if (
          args.command !== undefined &&
          (typeof args.command !== 'string' || args.command.length > STUDIO_LOCAL_SERVER_MAX_COMMAND)
        ) {
          return toolError(
            'invalid_arguments',
            `"command" must be a string of at most ${STUDIO_LOCAL_SERVER_MAX_COMMAND} characters when provided.`,
          )
        }
        if (
          args.cwd !== undefined &&
          (typeof args.cwd !== 'string' || !isAbsolute(args.cwd) || args.cwd.length > 4096)
        ) {
          return toolError('invalid_arguments', '"cwd" must be an absolute folder path when provided.')
        }
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        const outcome = await deps.link(
          { workspaceId: metadata.workspaceId, agentId: metadata.agentId },
          {
            url: address.url,
            ...(title ? { title } : {}),
            ...(command ? { command } : {}),
            ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
          },
        )
        if (!outcome.ok) return toolError(outcome.code, outcome.message)
        const { server } = outcome
        return toolSuccess({
          linked: true,
          server: { id: server.id, url: server.url, title: server.title, state: server.state },
        })
      },
    },
  ]
}
