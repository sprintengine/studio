// The MCP protocol versions the TypeScript side can honestly serve.
//
// One table, imported by the socket gateway (`src/main/automation/mcp-socket-server.ts`)
// and by main's HTTP client of the Python engine (`src/main/sprintengine-mcp-hub.ts`),
// because the previous inline constants are exactly how the two Multicode MCP
// servers drifted apart — this gateway fell back to `2025-03-26` while the
// engine defaulted to `2024-11-05`.
//
// A version belongs here only once the semantics behind it exist: answering
// `initialize` with a version we do not implement is the lie this module was
// created to remove. The Python half is `sprintengine_mcp/protocol.py` and
// carries the same set. Lives in `shared` — no node-only imports — beside
// `normalize-server.ts`, because a main-process server and a main-process
// client both need it.

/** Newest-first. The head is what we answer when the client's ask is not on the list. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']

export const DEFAULT_MCP_PROTOCOL_VERSION: string = SUPPORTED_MCP_PROTOCOL_VERSIONS[0]

export function isSupportedMcpProtocolVersion(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(value)
}

/**
 * Answer a supported request with itself, anything else with the default.
 *
 * Never throws. The spec's rule for an unsupported `initialize` is to respond
 * with a version the server does support and let the client decide whether to
 * continue; an error here would break clients that would have accepted our
 * answer. `requested` is `unknown` because it arrives straight off the wire, so
 * an absent field, `null`, or a non-string all land in the same branch.
 */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  return isSupportedMcpProtocolVersion(requested) ? requested : DEFAULT_MCP_PROTOCOL_VERSION
}
