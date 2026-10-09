// MCP tool contract for the Studio gateway. Node-free on purpose:
// these shapes are shared by the socket server (src/main/automation), the
// module host's contribution point (MainHost.registerMcpTools), and the SDK
// mirror in packages/module-sdk — src/shared cannot import src/main (TS6307).

import { STUDIO_BUILT_IN_TOOLSETS } from '../../../packages/studio-protocol/src/public'
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
   * that writes to disk, spawns a process, or reconfigures the machine. A
   * third-party module's tool that omits it is registered as mutating; only an
   * explicit `false` makes it a read.
   */
  mutates?: boolean
  handler: (args: Record<string, unknown>, context?: McpConnectionContext) => Promise<McpToolResult>
}

export type McpConnectionMetadata = {
  /**
   * `studio-agent`/`external-local` reach the gateway over the owner-only local
   * socket. A declared identity is advisory — anything with filesystem access
   * could claim it — unless the connection presented the launch token Studio
   * issued that agent's launch, in which case the identity is the token's.
   * `remote-tailnet` is the opt-in tailnet listener, where the transport
   * PROVED which paired device is calling before dispatch.
   */
  kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
  workspaceId?: string
  agentId?: string
  agentName?: string
  cliId?: string
  /** Paired tailnet device id; set by the transport, never by the client. */
  deviceId?: string
  /** Human name that device was paired under. */
  deviceName?: string
  /** Tailscale node name of the calling peer; absent when whois could not resolve it. */
  peerNode?: string
  /**
   * Whether the identity above was PROVEN rather than declared: true when the
   * connection presented the launch token Studio issued that agent's launch,
   * or when the tailnet transport established the paired device. A module
   * tool's handler always receives it set (the gateway fills in `false`); it
   * is optional here because core transports write metadata before that.
   */
  verified?: boolean
}

export type McpConnectionContext = {
  metadata: McpConnectionMetadata
}

// ── Tool names ───────────────────────────────────────────────────────────────

/**
 * The name an MCP client files a tool under. Several clients take no dot in a
 * tool name and write `backlog_list` for `backlog.list`, so a module's
 * `backlog_list` and the core's `backlog.list` are one name to the agent.
 * Collisions are judged on this form, never on the raw strings.
 */
export function mcpToolWireName(name: string): string {
  return name.trim().toLowerCase().replace(/\./gu, '_')
}

/**
 * The core gateway tool a module tool name would collide with, or null. A
 * collision is the same wire name as a core tool, or a name in one of the
 * shell's own families (`browser_*`, `canvas.*`, …).
 */
export function coreMcpToolConflict(name: string, coreToolNames: Iterable<string>): string | null {
  const wire = mcpToolWireName(name)
  for (const core of coreToolNames) {
    if (mcpToolWireName(core) === wire) return core
  }
  // The desktop shell's own toolsets (the browser, the canvas, the editor, diff
  // tours, terminals) are reserved whether or not the window has offered them
  // yet: a module tool in one would shadow a shell tool once it connects.
  const family = STUDIO_BUILT_IN_TOOLSETS.find((candidate) => wire.startsWith(`${candidate}_`))
  return family ? `${family}.*` : null
}

// Result shaping every gateway tool needs, core-owned and module-owned alike.
// They live beside the contract rather than in core's gateway file so a module
// tree can answer in the gateway's own vocabulary without importing core's
// gateway. Types above are drift-guarded against the SDK mirror;
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
