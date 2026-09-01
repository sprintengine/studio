export type TailnetPeerResolver = {
    /** Tailscale node name for a remote address, or null when it cannot be resolved. */
    resolve(remoteAddress: string): Promise<string | null>;
};
export declare function createTailnetPeerResolver(options?: {
    now?: () => number;
    timeoutMs?: number;
    cacheTtlMs?: number;
    /** Injected in tests; production runs `tailscale whois --json <addr>`. */
    runWhois?: (remoteAddress: string) => Promise<string | null>;
    log?: (message: string) => void;
}): TailnetPeerResolver;
/**
 * Node's `remoteAddress` may be an IPv4-mapped IPv6 (`::ffff:100.x.y.z`) or a
 * scoped IPv6 (`fd7a:...%utun4`); whois wants the bare address.
 */
export declare function normalizeAddress(remoteAddress: string | undefined | null): string;
/**
 * Pull the node name out of a `tailscale whois --json` payload.
 *
 * Exported for the test: the shape is Tailscale's, so pinning our reading of it
 * is the only way to notice if we are reading it wrong.
 */
export declare function peerNameFromWhois(raw: string): string | null;
