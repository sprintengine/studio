// The tailnet listener's route table, in its own module so both the gateway
// server and the terminal stream can name a path without importing each other.

const TAILNET_ROUTE_PREFIX = '/tailnet/v1'
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

// ── What this transport speaks ───────────────────────────────────────────────
//
// Here rather than in the gateway server for the same reason the paths are:
// the version and the capability list are the wire's own facts, and a client
// (the phone) reads them from `health` before it has any other opinion about
// this machine.

/** Bumped when the wire changes in a way a client must know about. 2 (2026-09-06): the change feed, sliced replay frames, git only for running sessions. */
export const TAILNET_TRANSPORT_VERSION = 2

/**
 * The oldest wire this build will still drive.
 *
 * A window rather than an equality because the two ends of a tailnet are two
 * separate installs that update on their own schedule, and refusing the machine
 * that updated last week is worse than talking to it. One version of slack is
 * what an ordinary "I'll update it this weekend" costs.
 *
 * It can be 1 and not 2 because nothing version 2 changed makes a version 1 peer
 * unreadable: its two new routes are named capabilities a version 1 peer does
 * not advertise, and its one behaviour change (git facts only for running
 * sessions) leaves a version 1 peer answering a superset of what a version 2
 * client expects. Neither is a shape this build would misread. When a bump DOES
 * change the shape of something already shipped, this constant moves up with
 * it. See `docs/compatibility.md`.
 */
export const TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION = 1

/**
 * Additive features a client may rely on; a purely additive feature ships here
 * without a version bump.
 *
 * `upload` was served from 2026-09-05 and advertised from 2026-09-07. Until it
 * was named here the route was undiscoverable, and a phone's only way to find
 * out was to send the file and read the 404 at the end of the transfer — the
 * one failure a 25MB upload must not have.
 */
export const TAILNET_CAPABILITIES = ['events', 'sliced-frames', 'upload'] as const

export type TailnetCapability = (typeof TAILNET_CAPABILITIES)[number]

/**
 * Does this peer offer a feature, according to what it said in the handshake?
 *
 * The question to ask before using anything the transport did not always have.
 * A version comparison would answer it too, but only by encoding "events landed
 * in 2" in every caller, which is the fact that goes stale: a capability may be
 * withdrawn by a build that keeps the version, and back-porting one to an older
 * version is exactly the move the capability list exists to allow.
 *
 * A peer that advertises no list at all (anything before the field shipped)
 * therefore has no capabilities, not all of them — this answers "may I RELY on
 * X", and silence is not a promise. It is not the same question as "should I
 * stop trying X", where silence means only that we do not know; the change-feed
 * gate in `tailnet-fleet-service.ts` keeps the two apart.
 */
export function tailnetPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: TailnetCapability,
): boolean {
  return capabilities?.includes(capability) ?? false
}

/** A handshake refused for speaking a wire this build does not. */
export type TailnetTransportRefusal = {
  code: 'unsupported_transport_version'
  message: string
}

/** `1–2`, collapsing to `2` on its own once the window narrows to one version. */
function supportedTransportVersions(): string {
  return [...new Set<number>([TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION, TAILNET_TRANSPORT_VERSION])].join('–')
}

/**
 * Check a peer's advertised transport version, returning null when it is one we
 * speak and a refusal when it is not.
 *
 * The whole point is that this fires at the handshake. Until it did, a peer on
 * an incompatible wire was accepted and then failed somewhere downstream on a
 * payload shape — a tool answering in a form this build could not read, a frame
 * with a field that moved — which is the expensive kind of failure: it surfaces
 * far from its cause and reads as a bug in whatever tool happened to be called.
 *
 * The refusal names both versions because that is the whole diagnosis. "Cannot
 * connect" sends someone to the network; "that machine speaks 4, this one
 * speaks 1–2" tells them which of the two installs to update.
 */
export function checkTailnetTransportVersion(seen: unknown): TailnetTransportRefusal | null {
  if (
    Number.isInteger(seen) &&
    (seen as number) >= TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION &&
    (seen as number) <= TAILNET_TRANSPORT_VERSION
  ) {
    return null
  }
  // A peer that states nothing readable gets its own sentence: "speaks version
  // undefined" would read as a bug here rather than as a fact about that machine.
  const seenClause = Number.isInteger(seen)
    ? `That machine speaks transport version ${seen as number}`
    : 'That machine did not state a transport version this build could read'
  return {
    code: 'unsupported_transport_version',
    message: `${seenClause}; this build speaks ${supportedTransportVersions()}. Update whichever of the two is older.`,
  }
}
