// The MCP protocol versions the TypeScript side can honestly serve.
//
// One table, imported by the socket gateway (`src/main/automation/mcp-socket-server.ts`)
// and by every other MCP speaker in the app, because inline constants are
// exactly how two MCP servers in one product drift apart — one fell back to
// `2025-03-26` while the other defaulted to `2024-11-05`.
//
// A version belongs here only once the semantics behind it exist: answering
// `initialize` with a version we do not implement is the lie this module was
// created to remove. Lives in `shared` — no node-only imports — beside
// `normalize-server.ts`, because a main-process server and a main-process
// client both need it.

/** Newest-first. The head is what we answer when the client's ask is not on the list. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [
  // Earned by the socket gateway (item 2141): handshake-optional framing, the
  // per-request `_meta.protocolVersion` declaration, and `ttlMs` on tools/list.
  '2026-07-28',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

export const DEFAULT_MCP_PROTOCOL_VERSION: string = SUPPORTED_MCP_PROTOCOL_VERSIONS[0]

export function isSupportedMcpProtocolVersion(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(value)
}

/**
 * Answer a supported request with itself, an unknown one with the newest
 * version we serve that is no NEWER than the ask.
 *
 * Never throws. The spec's rule for an unsupported `initialize` is to respond
 * with a version the server does support and let the client decide whether to
 * continue; an error here would break clients that would have accepted our
 * answer. `requested` is `unknown` because it arrives straight off the wire, so
 * an absent field, `null`, or a non-string all land in the same branch.
 *
 * Answering the unknown ask with our MAXIMUM is what broke Claude Code: it
 * offers a revision between `2025-06-18` and `2026-07-28`, so handing back
 * `2026-07-28` names a version newer than the client can parse and the
 * handshake is rejected outright — every agent we spawned lost its tools. Downgrading instead lands on `2025-06-18`, which both sides speak.
 * Versions are ISO dates, so lexicographic order is chronological order.
 */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (isSupportedMcpProtocolVersion(requested)) return requested
  if (typeof requested !== 'string' || requested === '') return DEFAULT_MCP_PROTOCOL_VERSION
  // Newest-first, so the first entry at or below the ask is the best downgrade.
  const downgrade = SUPPORTED_MCP_PROTOCOL_VERSIONS.find((version) => version <= requested)
  // No entry at or below means the client is older than anything we serve;
  // answer our oldest and let it decide, rather than our newest.
  return downgrade ?? SUPPORTED_MCP_PROTOCOL_VERSIONS[SUPPORTED_MCP_PROTOCOL_VERSIONS.length - 1]
}
