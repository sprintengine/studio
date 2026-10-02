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
import { runGatewayCall, type GatewayCallScope } from '../../server/tools/client-tool-gateway'
import type { ClientToolServedBy } from '../../server/tools/client-tool-registry'

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
// surface live; a client on a persistent transport also gets
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

/** What a transport gives one message beyond its params: its JSON-RPC id, and a way to send the caller a notification. */
export type McpDispatchIo = {
  requestId?: JsonRpcId
  notify?: (message: Record<string, unknown>) => void
}

export type McpDispatcher = {
  dispatch(
    method: string,
    params: Record<string, unknown>,
    context: McpConnectionContext,
    gate?: McpDispatchGate,
    io?: McpDispatchIo,
  ): Promise<McpDispatchOutcome>
}

/** One gateway tool call, as the audit hook hears it. */
export type McpToolCallEvent = {
  context: McpConnectionContext
  tool: string
  args: Record<string, unknown>
  durationMs: number
  result?: McpToolResult
  error?: unknown
  /** The client that ran it, for a tool a client offers. */
  servedBy?: ClientToolServedBy
}

/** What the gateway's client tools add to the dispatcher. */
export type McpClientToolHooks = {
  /** Settles once a server that expects its shell's toolsets has them, or has waited long enough. */
  ready(): Promise<void>
  /** A call to a client tool this connection was never listed: answered rather than refused as unknown. */
  fallback(context: McpConnectionContext, name: string): McpToolRegistration | null
}

// The tools/call requests running on each connection, by their JSON-RPC id,
// so an agent's `notifications/cancelled` can stop one.
const runningCalls = new WeakMap<McpConnectionContext, Map<string, AbortController>>()
const callKey = (id: JsonRpcId) => (typeof id === 'number' ? `n:${id}` : `s:${String(id)}`)

export function createMcpDispatcher(options: {
  serverName: string
  serverVersion: string
  /** The tools this connection may see, resolved per request: client tools differ by connection. */
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  clientTools?: McpClientToolHooks
  onToolCall?: (event: McpToolCallEvent) => void
}): McpDispatcher {
  return {
    async dispatch(method, params, context, gate, io): Promise<McpDispatchOutcome> {
      switch (method) {
        case 'sprintengine.studio/connect': {
          const declared = applyDeclaredConnectionMetadata(context.metadata, params)
          if (!declared.ok) return { kind: 'error', code: JSONRPC_INVALID_REQUEST, errorMessage: declared.message }
          context.metadata = declared.metadata
          return { kind: 'no_response' }
        }
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
        case 'notifications/cancelled': {
          // The agent gave up on a call: one a client is running is cancelled
          // there too. A call that already answered, or an id never seen, is nothing.
          const requestId = params.requestId
          if (typeof requestId === 'string' || typeof requestId === 'number')
            runningCalls.get(context)?.get(callKey(requestId))?.abort()
          return { kind: 'no_response' }
        }
        case 'ping':
          return { kind: 'result', value: {} }
        case 'tools/list': {
          await options.clientTools?.ready()
          const resolved = options.resolveTools(context)
          const tools = gate?.filterTools ? gate.filterTools(resolved) : resolved
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
          await options.clientTools?.ready()
          const tool =
            options.resolveTools(context).find((candidate) => candidate.name === name) ??
            options.clientTools?.fallback(context, name) ??
            null
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
          // A call the agent may cancel, and whose progress it asked to hear.
          const controller = new AbortController()
          const key = io?.requestId === undefined || io.requestId === null ? null : callKey(io.requestId)
          const running = runningCalls.get(context) ?? new Map<string, AbortController>()
          runningCalls.set(context, running)
          if (key) running.set(key, controller)
          const meta = isRecord(params._meta) ? params._meta : undefined
          const progressToken =
            typeof meta?.progressToken === 'string' || typeof meta?.progressToken === 'number'
              ? meta.progressToken
              : undefined
          let steps = 0
          const scope: GatewayCallScope = {
            signal: controller.signal,
            ...(progressToken !== undefined && io?.notify
              ? {
                  progress: (update) => {
                    // MCP progress must rise; a client that names no number still moves it.
                    steps = Math.max(steps + 1, typeof update.progress === 'number' ? update.progress : 0)
                    io.notify!({
                      jsonrpc: '2.0',
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: steps,
                        ...(typeof update.total === 'number' ? { total: update.total } : {}),
                        ...(update.message ? { message: update.message } : {}),
                      },
                    })
                  },
                }
              : {}),
          }
          try {
            const result = await runGatewayCall(scope, () => tool.handler(args, context))
            options.onToolCall?.({
              context,
              tool: name,
              args,
              durationMs: Date.now() - startedAt,
              result,
              ...(scope.servedBy ? { servedBy: scope.servedBy } : {}),
            })
            return { kind: 'result', value: result as unknown as Record<string, unknown> }
          } catch (error) {
            options.onToolCall?.({ context, tool: name, args, durationMs: Date.now() - startedAt, error })
            throw error
          } finally {
            if (key && running.get(key) === controller) running.delete(key)
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
 *
 * And a declared agent stays that agent. An agent's launches are capped at its
 * own permission preset (launch-permission-cap.ts), so a connection that could
 * re-declare itself as another agent, or as no agent at all, could shed the
 * cap with one more frame. The bridge declares once per connection and a
 * reconnect is a new connection, so nothing legitimate changes the agent or
 * workspace mid-connection; the name and CLI may still be re-stated. This
 * guards the frames an agent can reach through its own tools; a caller with a
 * shell can open a fresh socket and declare anything, which is why the cap
 * rests on an agent on `none` having to ask before it runs one.
 */
function applyDeclaredConnectionMetadata(
  established: McpConnectionMetadata,
  params: Record<string, unknown>,
): { ok: true; metadata: McpConnectionMetadata } | { ok: false; message: string } {
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
  if (
    established.kind === 'studio-agent' &&
    (declared.agentId !== established.agentId || declared.workspaceId !== established.workspaceId)
  ) {
    return {
      ok: false,
      message:
        `This connection is agent "${established.agentId}" and cannot re-declare itself as another agent, ` +
        'another workspace, or no agent at all.',
    }
  }
  if (established.kind !== 'remote-tailnet') return { ok: true, metadata: declared }
  return {
    ok: true,
    metadata: {
      ...declared,
      kind: 'remote-tailnet',
      deviceId: established.deviceId,
      deviceName: established.deviceName,
      peerNode: established.peerNode,
    },
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
  header?: string | null,
): DeclaredProtocolVersion {
  if (typeof header === 'string' && header.trim()) {
    return isSupportedMcpProtocolVersion(header.trim())
      ? { kind: 'supported' }
      : { kind: 'unsupported', value: header.trim() }
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
