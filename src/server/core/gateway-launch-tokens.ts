import { createHash, randomBytes } from 'node:crypto'

// Every agent Studio launches is issued its own gateway token, bound to the
// conversation it belongs to, and taken back when the launch ends. The MCP
// bridge the agent's CLI starts presents it on its `sprintengine.studio/connect`,
// and the gateway takes the agent's identity from the token, never from what
// the connection declares beside it.
//
// A declared identity is only a claim: any process of this user could open the
// gateway's socket and say it is any agent. That was enough while the identity
// only labelled the audit and capped an agent's own launches, but an app's
// tools reach the conversations it started, so a claim would let any local
// agent reach tools an app offered to someone else's chat. The token is what
// a launch holds and nothing else does: it is handed to the CLI in its own
// environment (or on its stdin, inside a WSL distribution, where it is also the
// channel token the helper opens a bridge's channel with) and is never written
// into a file or onto a command line.
//
// Tokens are kept as their SHA-256, in this process only: a restart voids
// every one, as it ends every launch.

export type GatewayLaunchIdentity = {
  workspaceId: string
  agentId: string
  agentName?: string
  cliId?: string
}

const tokens = new Map<string, GatewayLaunchIdentity>()
// A launch that never ends is a leak, not a security property; this bounds it.
const MAX_LIVE_TOKENS = 4096

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Issue a token for one launch. `token` registers one the caller already
 * minted (a WSL launch's channel token, which the helper checks too).
 */
export function issueGatewayLaunchToken(identity: GatewayLaunchIdentity, token?: string): string {
  const issued = token ?? `selaunch_${randomBytes(32).toString('base64url')}`
  tokens.set(digest(issued), {
    workspaceId: identity.workspaceId,
    agentId: identity.agentId,
    ...(identity.agentName ? { agentName: identity.agentName } : {}),
    ...(identity.cliId ? { cliId: identity.cliId } : {}),
  })
  while (tokens.size > MAX_LIVE_TOKENS) tokens.delete(tokens.keys().next().value!)
  return issued
}

/** The launch ended: its token proves nothing from now on. */
export function revokeGatewayLaunchToken(token: string | null | undefined): void {
  if (token) tokens.delete(digest(token))
}

/** Who a token was issued to, or null for a token no live launch holds. */
export function resolveGatewayLaunchToken(token: string): GatewayLaunchIdentity | null {
  if (!token) return null
  const found = tokens.get(digest(token))
  return found ? { ...found } : null
}

/**
 * The launch identity a child's environment names (`SPRINTENGINE_WORKSPACE_ID`
 * and `SPRINTENGINE_AGENT_ID`, with its name and CLI), or null for a child
 * that is no agent of a conversation.
 */
export function launchIdentityOfEnv(env: Readonly<Record<string, string | undefined>>): GatewayLaunchIdentity | null {
  const workspaceId = env.SPRINTENGINE_WORKSPACE_ID?.trim()
  const agentId = env.SPRINTENGINE_AGENT_ID?.trim()
  if (!workspaceId || !agentId) return null
  const agentName = env.SPRINTENGINE_AGENT_NAME?.trim()
  const cliId = env.SPRINTENGINE_AGENT_CLI?.trim()
  return { workspaceId, agentId, ...(agentName ? { agentName } : {}), ...(cliId ? { cliId } : {}) }
}
