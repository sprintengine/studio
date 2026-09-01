import type { TailnetPeer, TailnetPeerScan, TailnetPeerStudio } from '../../../shared/tailnet-peers';
export type TailnetPeerScanner = {
    scan(input: {
        port: number;
    }): Promise<TailnetPeerScan>;
};
export declare function createTailnetPeerScanner(options?: {
    /** Injected in tests; production runs `tailscale status --json`. */
    runStatus?: () => Promise<string | null>;
    /** Injected in tests; production opens a real HTTP request to the peer. */
    probe?: (address: string, port: number) => Promise<TailnetPeerStudio | null>;
    log?: (message: string) => void;
}): TailnetPeerScanner;
type ParsedStatus = {
    ok: true;
    backendRunning: boolean;
    peers: Array<Omit<TailnetPeer, 'studio'>>;
} | {
    ok: false;
    reason: string;
};
/**
 * Read `tailscale status --json` into the peers a picker can offer.
 *
 * Exported for the test: the shape is Tailscale's, so pinning our reading of it
 * is the only way to notice if we are reading it wrong. Fields we do not
 * understand are dropped rather than guessed — a node with no usable tailnet
 * address is not a machine anything can dial, so it is not listed.
 */
export declare function parseTailscaleStatus(raw: string): ParsedStatus;
/**
 * Ask one peer whether a Studio listener answers on `port`.
 *
 * A peer is only reported as a Studio when the payload is exactly the health
 * shape: the right product string, an integer transport version, and a list of
 * protocol version strings. Anything else on that port — another service, an
 * error page, a captive portal — is not a Studio, and treating a stray 200 as
 * one would put an undrivable machine in the picker.
 */
export declare function probeStudioListener(address: string, port: number): Promise<TailnetPeerStudio | null>;
/**
 * Read a health payload, or null when it is not one.
 *
 * Exported for the test: this is the boundary where another machine's bytes
 * become something this app believes, so what it will and will not accept is
 * worth pinning. Only the three published fields are read; extra fields in a
 * future version are ignored rather than carried into the app.
 */
export declare function readHealthPayload(body: string): TailnetPeerStudio | null;
export {};
