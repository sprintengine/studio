import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../../shared/modules/mcp-tools';
import { type TailnetPairingOfferView, type TailnetRemoteStatus, type TailnetScope } from '../../../shared/tailnet';
import type { TailnetPeerScan } from '../../../shared/tailnet-peers';
import { type TailnetDeviceStore } from './tailnet-devices';
import { type TailnetPeerResolver } from './tailnet-peer-identity';
import { type TailnetPeerScanner } from './tailnet-peers';
import type { TerminalRemoteHost } from '../../terminal-remote-attach';
export type TailnetRemoteService = {
    /** Start the listener if, and only if, it is enabled and a tailnet exists. */
    initialize(): Promise<TailnetRemoteStatus>;
    getStatus(): TailnetRemoteStatus;
    setEnabled(enabled: boolean): Promise<TailnetRemoteStatus>;
    /** Mint a one-time pairing code. The token is returned once and never re-readable. */
    offerPairing(input?: {
        scopes?: unknown;
    }): TailnetPairingOfferView;
    cancelPairing(): TailnetRemoteStatus;
    revokeDevice(deviceId: string): TailnetRemoteStatus;
    /**
     * Machines on this tailnet, and which of them answer as a Studio.
     *
     * Independent of this machine's own listener: discovering somewhere to
     * connect TO does not require having enabled being connected to.
     */
    listPeers(): Promise<TailnetPeerScan>;
    /**
     * Tailscale's name for a tailnet address, or null.
     *
     * Shared with the Fleet client (MC-2167) so a machine this Studio pairs WITH
     * is labelled by the same resolver — and the same ~5-minute cache — that names
     * the peers driving this one. Two resolvers would mean two `whois` spawns for
     * one question.
     */
    resolvePeerName(address: string): Promise<string | null>;
    notifyToolsListChanged(): void;
    shutdown(): Promise<void>;
};
export type TailnetRemoteServiceOptions = {
    resolveUserDataDir: () => string;
    serverName: string;
    serverVersion: string;
    resolveTools: () => McpToolRegistration[];
    isMutation: (toolName: string) => boolean;
    onToolCall?: (event: {
        context: McpConnectionContext;
        tool: string;
        args: Record<string, unknown>;
        durationMs: number;
        result?: McpToolResult;
        error?: unknown;
    }) => void;
    /**
     * Watch-and-type access to this machine's terminals (MC-2165), for the
     * listener's terminal WebSocket. Absent (tests, an unwired build) leaves that
     * route refusing with a stated reason; nothing else about the listener changes.
     */
    terminals?: TerminalRemoteHost;
    /** Injected in tests. Production reads this machine's real interfaces. */
    resolveBindAddress?: () => string | null;
    createPeerScanner?: () => TailnetPeerScanner;
    createDeviceStore?: (options: {
        resolveUserDataDir: () => string;
        log?: (message: string) => void;
    }) => TailnetDeviceStore;
    createPeerResolver?: () => TailnetPeerResolver;
    log?: (message: string) => void;
};
export declare function createTailnetRemoteService(options: TailnetRemoteServiceOptions): TailnetRemoteService;
/** IPv6 literals need brackets before a port; IPv4 must not have them. */
export declare function formatEndpoint(address: string, port: number): string;
/**
 * One scannable string carrying everything a client needs to pair: where to
 * reach the listener, and the one-time code. A custom scheme rather than an
 * http URL so scanning it in a browser cannot accidentally spend the code.
 */
export declare function pairingUrl(address: string, port: number, token: string): string;
export type { TailnetScope };
