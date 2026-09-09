// MCP tool contract for the Studio gateway (MC-1855). Node-free on purpose:
// these shapes are shared by the socket server (src/main/automation), the
// module host's contribution point (MainHost.registerMcpTools), and the SDK
// mirror in packages/module-sdk — src/shared cannot import src/main (TS6307).

import { isRecord } from '../records'

/** Re-exported: this module was the entry point importers already had. */
export { isRecord }

export type McpToolResult = {
  // Text, or an image part (a browser snapshot, base64 PNG/JPEG) the client
  // renders inline — the MCP `image` content shape.
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Declares that the tool CHANGES state. The Studio gateway reads it for two
   * decisions: a remote (tailnet) caller must hold `<family>:operate` rather
   * than the read-only `<family>:read` to invoke it, and every call — including
   * one refused for want of that scope — is written to the gateway audit with
   * the calling device. Omitted or false means a read: advertised to every
   * paired device on the read scope and not audited. Declare it on anything
   * that writes to disk, spawns a process, or reconfigures the machine.
   */
  mutates?: boolean
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

export function isMcpToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && Array.isArray(value.content)
}
