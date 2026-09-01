import { TOOLS_LIST_TTL_MS } from './mcp-dispatch';
import type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools';
export type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration, McpToolResult };
export { TOOLS_LIST_TTL_MS };
export type McpSocketServerOptions = {
    socketPath: string;
    serverName: string;
    serverVersion: string;
    /**
     * The current tool set, evaluated on every tools/list and tools/call rather
     * than captured at construction: module-contributed tools follow module
     * enablement live (MC-1855), and the gateway is constructed before modules
     * load, so a snapshot here would be permanently stale.
     */
    resolveTools: () => McpToolRegistration[];
    onToolCall?: (event: {
        context: McpConnectionContext;
        tool: string;
        args: Record<string, unknown>;
        durationMs: number;
        result?: McpToolResult;
        error?: unknown;
    }) => void;
    log?: (message: string) => void;
};
export type McpSocketServer = {
    start(): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
    /** Tell every connected client the tool set changed (module enable/disable). */
    notifyToolsListChanged(): void;
};
export declare function createMcpSocketServer(options: McpSocketServerOptions): McpSocketServer;
