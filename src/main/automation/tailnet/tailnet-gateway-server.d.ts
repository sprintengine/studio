import { type McpConnectionContext, type McpToolRegistration, type McpToolResult } from '../../../shared/modules/mcp-tools';
import type { TerminalRemoteHost } from '../../terminal-remote-attach';
import type { TailnetDeviceStore } from './tailnet-devices';
import type { TailnetPeerResolver } from './tailnet-peer-identity';
export { TAILNET_ROUTE_PREFIX, TAILNET_HEALTH_PATH, TAILNET_PAIR_PATH, TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_WS_TICKET_PATH, TAILNET_STREAM_PATH, TAILNET_TERMINAL_PATH, } from './tailnet-routes';
/** Version of THIS transport's envelope, separate from the MCP protocol version. */
export declare const TAILNET_TRANSPORT_VERSION = 1;
export type TailnetGatewayServerOptions = {
    bindAddress: string;
    /** 0 binds an ephemeral port; only tests use it, since a discoverable listener needs a fixed one. */
    port: number;
    serverName: string;
    serverVersion: string;
    resolveTools: () => McpToolRegistration[];
    /** The gateway's own mutation classification, so scopes cannot drift from the audit's. */
    isMutation: (toolName: string) => boolean;
    devices: TailnetDeviceStore;
    peers: TailnetPeerResolver;
    /**
     * Watch-and-type access to this machine's terminals (MC-2165). Absent leaves
     * the terminal WebSocket route answering `terminal_streaming_unavailable`
     * rather than pretending the transport is there — the structured tool surface
     * is unaffected either way.
     */
    terminals?: TerminalRemoteHost;
    onToolCall?: (event: {
        context: McpConnectionContext;
        tool: string;
        args: Record<string, unknown>;
        durationMs: number;
        result?: McpToolResult;
        error?: unknown;
    }) => void;
    now?: () => number;
    log?: (message: string) => void;
};
export type TailnetGatewayServer = {
    start(): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
    /** The address actually bound, or null while stopped. */
    address(): {
        address: string;
        port: number;
    } | null;
    notifyToolsListChanged(): void;
    /** Live WebSocket streams, by device — diagnostics and tests. */
    streamCount(): number;
    /** Live attached terminals — diagnostics and tests. */
    terminalStreamCount(): number;
};
export declare function createTailnetGatewayServer(options: TailnetGatewayServerOptions): TailnetGatewayServer;
