import { isRecord } from '../../shared/records'

/** Re-exported: this module was the entry point importers already had. */
export { isRecord }
import {
  isSupportedMcpProtocolVersion,
  negotiateMcpProtocolVersion,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from '../../shared/mcp/protocol'
import type {
  McpConnectionContext,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
} from '../../shared/modules/mcp-tools'

// The gateway's MCP method semantics, independent of how bytes arrive.
//
// Two transports carry the same surface: the owner-only local socket
// (mcp-socket-server.ts) and the opt-in tailnet HTTP/WS listener
// (tailnet/tailnet-gateway-server.ts). Everything they must agree on —
// protocol-version negotiation and validation, the tools/list TTL, how a
// tools/call failure is reported, when the audit hook fires — lives here, so a
// change to the contract cannot land on one transport and miss the other.
//
// What stays in the transports: framing, connection lifetime, and
// authentication. The local socket's authentication is filesystem permissions;
// the tailnet listener's is a device token, and it passes its scope decision in
// through `McpDispatchGate`.

export const JSONRPC_PARSE_ERROR = -32700
export const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INVALID_PARAMS = -32602
export const JSONRPC_INTERNAL_ERROR = -32603

// How long a client may reuse a tools/list answer (2026-07-28's `ttlMs`, SEP-2549).
// Five minutes rather than a session, because module enable/disable rewrites this
// surface live (MC-1855); a client on a persistent transport also gets
// notifications/tools/list_changed the moment it does, so the TTL is the floor for
// a client that ignores notifications, not the mechanism. `cacheScope` is
// deliberately absent: the gateway serves one client scope, so there is
// nothing for a client to key a cache by.
const TOOLS_LIST_TTL_MS = 300_000

type McpDispatchOutcome =
  | { kind: 'result'; value: Record<string, unknown> }
  | { kind: 'error'; code: number; errorMessage: string }
  | { kind: 'no_response' }

/**
 * A transport's authorization hooks. Absent (the local socket) means the
 * connection may see and call everything the gateway serves.
 */
export type McpDispatchGate = {
  /** Narrow what `tools/list` reports for this caller. */
  filterTools?: (tools: McpToolRegistration[]) => McpToolRegistration[]
  /**
   * Refuse a `tools/call` before the handler runs. Return the refusal as a tool
   * result (never a thrown error), or null to allow. A refusal still reaches
   * `onToolCall`, so a blocked mutation attempt is audited like any other.
   */
  authorizeToolCall?: (toolName: string) => McpToolResult | null
}

export type McpDispatcher = {
  dispatch(
    method: string,
    params: Record<string, unknown>,
    context: McpConnectionContext,
    gate?: McpDispatchGate
  ): Promise<McpDispatchOutcome>
}

export function createMcpDispatcher(options: {
  serverName: string
  serverVersion: string
  resolveTools: () => McpToolRegistration[]
  onToolCall?: (event: {
    context: McpConnectionContext
    tool: string
    args: Record<string, unknown>
    durationMs: number
    result?: McpToolResult
    error?: unknown
  }) => void
}): McpDispatcher {
  return {
    async dispatch(method, params, context, gate): Promise<McpDispatchOutcome> {
      switch (method) {
        case 'sprintengine.studio/connect':
          context.metadata = applyDeclaredConnectionMetadata(context.metadata, params)
          return { kind: 'no_response' }
        case 'initialize': {
          // Negotiate, never echo: a client asking for a version we do not
          // implement is answered with the newest one we do (shared/mcp/protocol).
          // Optional since 2026-07-28 removed the handshake, and it always was here:
          // this switch gates nothing on it, so tools/list and tools/call answer a
          // connection that never sent one. Nothing to un-gate; there is no gate.
          return {
            kind: 'result',
            value: {
              protocolVersion: negotiateMcpProtocolVersion(params.protocolVersion),
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: options.serverName, version: options.serverVersion },
            },
          }
        }
        case 'notifications/initialized':
          return { kind: 'no_response' }
        case 'ping':
          return { kind: 'result', value: {} }
        case 'tools/list': {
          const tools = gate?.filterTools ? gate.filterTools(options.resolveTools()) : options.resolveTools()
          return {
            kind: 'result',
            value: {
              tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
              ttlMs: TOOLS_LIST_TTL_MS,
            },
          }
        }
        case 'tools/call': {
          const name = typeof params.name === 'string' ? params.name : ''
          const tool = options.resolveTools().find((candidate) => candidate.name === name)
          if (!tool) {
            return { kind: 'error', code: JSONRPC_INVALID_PARAMS, errorMessage: `Unknown tool "${name}".` }
          }
          const args = isRecord(params.arguments) ? params.arguments : {}
          const refusal = gate?.authorizeToolCall?.(name)
          if (refusal) {
            options.onToolCall?.({ context, tool: name, args, durationMs: 0, result: refusal })
            return { kind: 'result', value: refusal as unknown as Record<string, unknown> }
          }
          // Tool-domain failures (unknown workspace, malformed payload) come back
          // as MCP tool results with isError: true — explicit, never fake success.
          const startedAt = Date.now()
          try {
            const result = await tool.handler(args, context)
            options.onToolCall?.({ context, tool: name, args, durationMs: Date.now() - startedAt, result })
            return { kind: 'result', value: result as unknown as Record<string, unknown> }
          } catch (error) {
            options.onToolCall?.({ context, tool: name, args, durationMs: Date.now() - startedAt, error })
            throw error
          }
        }
        default:
          return { kind: 'error', code: JSONRPC_METHOD_NOT_FOUND, errorMessage: `Method "${method}" is not supported.` }
      }
    },
  }
}

/**
 * Apply the advisory identity a client declares over `sprintengine.studio/connect`.
 *
 * The advisory fields are REPLACED wholesale, not merged: a re-declaration that
 * omits a field means the client is no longer claiming it, and carrying the old
 * value forward would attribute work to an agent that stopped saying it was
 * there. (This is the local socket's long-standing behaviour.)
 *
 * Transport-ESTABLISHED identity is untouchable. The tailnet listener proved
 * which paired device is calling before dispatch, so `kind: 'remote-tailnet'`
 * and its device fields survive whatever the client declares — otherwise a
 * remote caller could dress itself up as a trusted local Studio agent in the
 * audit log by sending one notification.
 */
function applyDeclaredConnectionMetadata(
  established: McpConnectionMetadata,
  params: Record<string, unknown>
): McpConnectionMetadata {
  const text = (key: string): string | undefined => {
    const value = params[key]
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : undefined
  }
  const agentId = text('agentId')
  const declared: McpConnectionMetadata = {
    kind: agentId ? 'studio-agent' : 'external-local',
    workspaceId: text('workspaceId'),
    agentId,
    agentName: text('agentName'),
    cliId: text('cliId'),
  }
  if (established.kind !== 'remote-tailnet') return declared
  return {
    ...declared,
    kind: 'remote-tailnet',
    deviceId: established.deviceId,
    deviceName: established.deviceName,
    peerNode: established.peerNode,
  }
}

export type DeclaredProtocolVersion = { kind: 'absent' | 'supported' } | { kind: 'unsupported'; value: unknown }

/**
 * Read a per-request version declaration.
 *
 * 2026-07-28 lets a client declare its protocol version per request instead of
 * once in a handshake. `header` is the spec channel where a transport has one
 * (HTTP's `MCP-Protocol-Version`); `params._meta.protocolVersion` is the whole
 * of that channel on a header-less transport, and the fallback on both.
 *
 * Absent means the client made no claim and gets the default behaviour.
 * Anything present that is not one of our supported strings — a stale date, a
 * number, `null` — is a claim we cannot honour, and is reported as one rather
 * than quietly read as absent. A declaration is a commitment, not a proposal:
 * `initialize` downgrades an unsupported ask (the client still gets to decide),
 * but a frame that says "I am 2099-01-01" has already decided, so the honest
 * answer is an error rather than serving it under semantics it did not ask for.
 */
export function declaredProtocolVersion(
  params: Record<string, unknown>,
  header?: string | null
): DeclaredProtocolVersion {
  if (typeof header === 'string' && header.trim()) {
    return isSupportedMcpProtocolVersion(header.trim()) ? { kind: 'supported' } : { kind: 'unsupported', value: header.trim() }
  }
  const meta = isRecord(params._meta) ? params._meta : undefined
  if (!meta || !('protocolVersion' in meta) || meta.protocolVersion === undefined) return { kind: 'absent' }
  const value = meta.protocolVersion
  return isSupportedMcpProtocolVersion(value) ? { kind: 'supported' } : { kind: 'unsupported', value }
}

export function unsupportedProtocolVersionMessage(value: unknown): string {
  return `Unsupported MCP protocol version ${quoteDeclared(value)}. This server supports: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}.`
}

/**
 * Render a rejected declaration for the error message.
 *
 * Bounded on purpose: the value is caller-controlled and a frame may be a
 * megabyte, so quoting it whole would let a client choose the size of our own
 * error response.
 */
function quoteDeclared(value: unknown): string {
  const rendered = JSON.stringify(value) ?? String(value)
  return rendered.length > 64 ? `${rendered.slice(0, 64)}…` : rendered
}

export type JsonRpcId = string | number | null

export function jsonRpcErrorResponse(id: JsonRpcId, code: number, errorMessage: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message: errorMessage } }
}

export function jsonRpcIdOf(value: unknown): JsonRpcId {
  if (!isRecord(value)) return null
  return typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null
}
