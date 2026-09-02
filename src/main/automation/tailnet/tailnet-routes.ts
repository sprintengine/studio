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
export const TAILNET_IDENTITY_PATH = `${TAILNET_ROUTE_PREFIX}/identity`
export const TAILNET_MCP_PATH = `${TAILNET_ROUTE_PREFIX}/mcp`
export const TAILNET_WS_TICKET_PATH = `${TAILNET_ROUTE_PREFIX}/ws-ticket`
export const TAILNET_STREAM_PATH = `${TAILNET_ROUTE_PREFIX}/stream`
/** One WebSocket per attached terminal, so a chatty session cannot stall the RPC stream. */
export const TAILNET_TERMINAL_PATH = `${TAILNET_ROUTE_PREFIX}/terminal`
