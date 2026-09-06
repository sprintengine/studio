// The tailnet listener's route table, in its own module so both the gateway
// server and the terminal stream can name a path without importing each other.

export const TAILNET_ROUTE_PREFIX = '/tailnet/v1'
export const TAILNET_HEALTH_PATH = `${TAILNET_ROUTE_PREFIX}/health`
export const TAILNET_PAIR_PATH = `${TAILNET_ROUTE_PREFIX}/pair`
/**
 * Pairing by approval on the machine being driven (MC-2233): POST asks, GET
 * polls the answer. Unauthenticated like `pair`, because a peer that has not
 * been approved yet has no credential by definition.
 */
export const TAILNET_PAIR_REQUEST_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request`
/**
 * The collect as a POST (pair-from-the-scan-and-stay-paired, phase 6): the
 * same poll `GET pair-request` answers, but with a body, so an approved
 * collect can carry the asker's reverse grant — a device it minted for this
 * machine — in the one exchange the approver already said yes to. GET stays
 * for clients that never offer one.
 */
export const TAILNET_PAIR_COLLECT_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request/collect`
export const TAILNET_IDENTITY_PATH = `${TAILNET_ROUTE_PREFIX}/identity`
export const TAILNET_MCP_PATH = `${TAILNET_ROUTE_PREFIX}/mcp`
export const TAILNET_WS_TICKET_PATH = `${TAILNET_ROUTE_PREFIX}/ws-ticket`
export const TAILNET_STREAM_PATH = `${TAILNET_ROUTE_PREFIX}/stream`
/** One WebSocket per attached terminal, so a chatty session cannot stall the RPC stream. */
export const TAILNET_TERMINAL_PATH = `${TAILNET_ROUTE_PREFIX}/terminal`
/**
 * The change feed (2026-09-05): one idle WebSocket per paired device on which
 * this machine says "the terminal list changed" or "the workspace list
 * changed", so a device re-reads on the change instead of every thirty
 * seconds. Server-to-client only, throttled to one push per kind per second,
 * carrying nothing but the kind — the device reads through the tools it is
 * already scoped for. Not the RPC stream: a watcher is not "connected" the
 * way a device driving this machine is, and must not count as one.
 */
export const TAILNET_EVENTS_PATH = `${TAILNET_ROUTE_PREFIX}/events`
/**
 * One file from a paired device into a thread's own folder (backlog id 88).
 *
 * A plain streaming POST rather than a JSON-RPC tool: base64 inside an RPC
 * envelope inflates a 5MB photo by a third and buffers all of it at both ends,
 * where a stream to disk buffers none of it.
 */
export const TAILNET_UPLOAD_PATH = `${TAILNET_ROUTE_PREFIX}/upload`
