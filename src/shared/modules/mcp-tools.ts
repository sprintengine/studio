// MCP tool contract for the Studio gateway (MC-1855). Node-free on purpose:
// these shapes are shared by the socket server (src/main/automation), the
// module host's contribution point (MainHost.registerMcpTools), and the SDK
// mirror in packages/module-sdk — src/shared cannot import src/main (TS6307).

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, context?: McpConnectionContext) => Promise<McpToolResult>
}

export type McpConnectionMetadata = {
  /**
   * `studio-agent`/`external-local` reach the gateway over the owner-only local
   * socket and their identity is advisory — anything with filesystem access
   * could claim it. `remote-tailnet` is the opt-in tailnet listener (MC-2162),
   * where the transport PROVED which paired device is calling before dispatch.
   */
  kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
  workspaceId?: string
  agentId?: string
  agentName?: string
  cliId?: string
  sprintRunId?: string
  /** Paired tailnet device id; set by the transport, never by the client. */
  deviceId?: string
  /** Human name that device was paired under. */
  deviceName?: string
  /** Tailscale node name of the calling peer; absent when whois could not resolve it. */
  peerNode?: string
}

export type McpConnectionContext = {
  metadata: McpConnectionMetadata
}

// Result shaping every gateway tool needs, core-owned and module-owned alike.
// They live beside the contract rather than in core's gateway file so a module
// tree can answer in the gateway's own vocabulary without importing core's
// gateway (MC-1856). Types above are drift-guarded against the SDK mirror;
// these helpers are not part of that mirror.

export function toolSuccess(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

export function toolError(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isMcpToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && Array.isArray(value.content)
}
