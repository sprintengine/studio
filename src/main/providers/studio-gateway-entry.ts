// The app's MCP gateway as a chat's agent is handed it at launch.
//
// Every chat runtime that drives a CLI (Claude Code through the SDK, Codex's
// app-server, the ACP agents) is handed the gateway beside the session's own
// servers, so a chat can use Studio's tools whichever agent runs it. The entry
// carries the chat's identity, and the launch's gateway token reaches the
// bridge the CLI starts from it, each runtime in its own way: a Codex
// app-server holds the token in its environment and passes it on by name
// (`env_vars`); an ACP agent names a server's environment outright, so the
// entry carries the value.
//
// Always under the id a terminal launch pins the gateway into a workspace's
// config with (`STUDIO_MCP_SERVER_ID`), so a CLI that also reads such a pinned
// entry takes the launch's in its place rather than starting a second copy:
// Codex merges a `-c` override into the table of the same name, and OpenCode
// replaces a configured server with a session's of the same name.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { ConversationMcpServer } from '../../shared/conversation-runtime'
import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import { MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'

/** The app's gateway on the machine a chat's CLI runs on (a WSL host's, or this one's); null leaves it out. */
export type StudioMcpServerResolver = (input: { hostId?: ExecutionHostId }) => Promise<ConversationMcpServer | null>

/** Who a chat's gateway connection says it is; the launch token is what proves it. */
export type StudioGatewayIdentity = { workspaceId?: string; agentId?: string; cli: string }

/**
 * The gateway, stamped with the chat's identity, ahead of the session's own
 * servers, and nothing else under its id: a session server that reuses it
 * would be a second copy of the gateway, or would hide it.
 */
export function withStudioGateway(
  gateway: ConversationMcpServer | null,
  servers: readonly ConversationMcpServer[],
): ConversationMcpServer[] {
  if (!gateway) return [...servers]
  return [gateway, ...servers.filter((server) => server.id !== STUDIO_MCP_SERVER_ID)]
}

/**
 * The gateway entry for one chat: its identity in the entry's environment,
 * under the id the pinned workspace entry uses. `launchToken`:
 * - `{ byName: true }` names the token's variable for a CLI that passes
 *   variables on from its own environment (the token is the child's);
 * - `{ value }` carries the token itself, for a CLI that is told a server's
 *   environment outright (it travels in the protocol, on the child's stdin);
 * - null hands no token: the connection is the claim it declares.
 */
export function studioGatewayForChat(
  gateway: ConversationMcpServer,
  identity: StudioGatewayIdentity,
  launchToken: { byName: true } | { value: string } | null,
): ConversationMcpServer {
  const { envVarNames: declared, ...entry } = gateway
  const named = (declared ?? []).filter((name) => name !== MCP_CHANNEL_TOKEN_ENV)
  const envVarNames = launchToken && 'byName' in launchToken ? [...named, MCP_CHANNEL_TOKEN_ENV] : named
  return {
    ...entry,
    id: STUDIO_MCP_SERVER_ID,
    env: {
      ...gateway.env,
      ...(identity.workspaceId ? { SPRINTENGINE_WORKSPACE_ID: identity.workspaceId } : {}),
      ...(identity.agentId ? { SPRINTENGINE_AGENT_ID: identity.agentId } : {}),
      SPRINTENGINE_AGENT_CLI: identity.cli,
      ...(launchToken && 'value' in launchToken ? { [MCP_CHANNEL_TOKEN_ENV]: launchToken.value } : {}),
    },
    ...(envVarNames.length > 0 ? { envVarNames } : {}),
  }
}

/** Whether a server, as an ACP agent is told it, is the app's own gateway. */
export function isStudioGatewayName(name: string): boolean {
  return name === STUDIO_MCP_SERVER_ID
}
