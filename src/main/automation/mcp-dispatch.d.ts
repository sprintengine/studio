import type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools';
export declare const JSONRPC_PARSE_ERROR = -32700;
export declare const JSONRPC_INVALID_REQUEST = -32600;
export declare const JSONRPC_METHOD_NOT_FOUND = -32601;
export declare const JSONRPC_INVALID_PARAMS = -32602;
export declare const JSONRPC_INTERNAL_ERROR = -32603;
export declare const TOOLS_LIST_TTL_MS = 300000;
export type McpDispatchOutcome = {
    kind: 'result';
    value: Record<string, unknown>;
} | {
    kind: 'error';
    code: number;
    errorMessage: string;
} | {
    kind: 'no_response';
};
/**
 * A transport's authorization hooks. Absent (the local socket) means the
 * connection may see and call everything the gateway serves.
 */
export type McpDispatchGate = {
    /** Narrow what `tools/list` reports for this caller. */
    filterTools?: (tools: McpToolRegistration[]) => McpToolRegistration[];
    /**
     * Refuse a `tools/call` before the handler runs. Return the refusal as a tool
     * result (never a thrown error), or null to allow. A refusal still reaches
     * `onToolCall`, so a blocked mutation attempt is audited like any other.
     */
    authorizeToolCall?: (toolName: string) => McpToolResult | null;
};
export type McpDispatcher = {
    dispatch(method: string, params: Record<string, unknown>, context: McpConnectionContext, gate?: McpDispatchGate): Promise<McpDispatchOutcome>;
};
export declare function createMcpDispatcher(options: {
    serverName: string;
    serverVersion: string;
    resolveTools: () => McpToolRegistration[];
    onToolCall?: (event: {
        context: McpConnectionContext;
        tool: string;
        args: Record<string, unknown>;
        durationMs: number;
        result?: McpToolResult;
        error?: unknown;
    }) => void;
}): McpDispatcher;
/**
 * Apply the advisory identity a client declares over `sprintengine.studio/connect`.
 *
 * The advisory fields are REPLACED wholesale, not merged: a re-declaration that
 * omits a field means the client is no longer claiming it, and carrying the old
 * value forward would attribute work to an agent that stopped saying it was
 * there. (This is the local socket's long-standing behaviour.)
 *
 * Transport-ESTABLISHED identity is untouchable. The tailnet listener proved
 * which paired device is calling before dispatch, so `kind: 'remote-tailnet'`
 * and its device fields survive whatever the client declares — otherwise a
 * remote caller could dress itself up as a trusted local Studio agent in the
 * audit log by sending one notification.
 */
export declare function applyDeclaredConnectionMetadata(established: McpConnectionMetadata, params: Record<string, unknown>): McpConnectionMetadata;
export type DeclaredProtocolVersion = {
    kind: 'absent' | 'supported';
} | {
    kind: 'unsupported';
    value: unknown;
};
/**
 * Read a per-request version declaration.
 *
 * 2026-07-28 lets a client declare its protocol version per request instead of
 * once in a handshake. `header` is the spec channel where a transport has one
 * (HTTP's `MCP-Protocol-Version`); `params._meta.protocolVersion` is the whole
 * of that channel on a header-less transport, and the fallback on both.
 *
 * Absent means the client made no claim and gets the default behaviour.
 * Anything present that is not one of our supported strings — a stale date, a
 * number, `null` — is a claim we cannot honour, and is reported as one rather
 * than quietly read as absent. A declaration is a commitment, not a proposal:
 * `initialize` downgrades an unsupported ask (the client still gets to decide),
 * but a frame that says "I am 2099-01-01" has already decided, so the honest
 * answer is an error rather than serving it under semantics it did not ask for.
 */
export declare function declaredProtocolVersion(params: Record<string, unknown>, header?: string | null): DeclaredProtocolVersion;
export declare function unsupportedProtocolVersionMessage(value: unknown): string;
export type JsonRpcId = string | number | null;
export declare function jsonRpcErrorResponse(id: JsonRpcId, code: number, errorMessage: string): Record<string, unknown>;
export declare function jsonRpcIdOf(value: unknown): JsonRpcId;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
