import type { McpConnectionMetadata, McpToolResult } from './mcp-socket-server';
export declare const STUDIO_GATEWAY_AUDIT_FILENAME = "sprintengine-studio-mcp-audit.jsonl";
export type GatewayAuditRecord = {
    timestamp: string;
    connection: McpConnectionMetadata;
    tool: string;
    durationMs: number;
    outcome: 'success' | 'failure';
    errorCode?: string;
    targets: Record<string, string | number | boolean>;
    affected: Record<string, string | number | boolean>;
};
export type GatewayAuditStore = {
    record(input: {
        connection: McpConnectionMetadata;
        tool: string;
        durationMs: number;
        args: Record<string, unknown>;
        result?: McpToolResult;
        error?: unknown;
    }): void;
};
export declare function createGatewayAuditStore(options: {
    resolveUserDataDir: () => string;
    maxBytes?: number;
    backups?: number;
    now?: () => Date;
    log?: (message: string) => void;
}): GatewayAuditStore;
export declare function safeIdentifiers(value: unknown): Record<string, string | number | boolean>;
