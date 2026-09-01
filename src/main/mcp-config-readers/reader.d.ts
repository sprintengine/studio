import type { McpTransport } from '../../shared/electron-api';
import type { PluginMcpConfigFormat } from '../../shared/plugin-manifest';
/**
 * One server entry exactly as a CLI's own config file states it, before it is
 * attributed to a CLI or normalised into anything the app owns. The same shape
 * feeds the agent-capability read path and the import wizard's detection, so
 * there is one parser per format rather than two that eventually disagree.
 */
export type RawMcpServer = {
    id: string;
    name?: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    envVarNames?: string[];
    headers?: Record<string, string>;
    enabled?: boolean;
};
/**
 * `missing`, `unreadable` and `malformed` are three different answers on
 * purpose. A config file the CLI never created is normal; one that could not be
 * opened is a fault; and one that opened but could not be parsed is a different
 * fault — the likeliest real-world one here, since rendering a `.mcp.json` with
 * a syntax error as "no servers" would be a lie.
 */
export type ReadServersResult = {
    ok: true;
    servers: RawMcpServer[];
} | {
    ok: false;
    reason: 'missing' | 'unreadable' | 'malformed';
    message: string;
};
export interface McpConfigReader {
    format: PluginMcpConfigFormat;
    read(absolutePath: string): Promise<ReadServersResult>;
}
/**
 * The filesystem half every adapter shares: read the bytes, map the errno to a
 * reason, and let the format's own parser throw for anything it cannot make
 * sense of. Adapters stay pure string → servers functions, which is also what
 * makes them testable against a fixture without touching disk.
 */
export declare function createFileMcpConfigReader(format: PluginMcpConfigFormat, parse: (raw: string) => RawMcpServer[]): McpConfigReader;
