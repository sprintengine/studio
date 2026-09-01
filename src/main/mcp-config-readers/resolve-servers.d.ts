import type { PluginMcpConfigFormat, PluginMcpConfigSpec } from '../../shared/plugin-manifest';
import type { AgentMcpServer, CapabilityDiagnostic } from '../../shared/skills';
import type { McpConfigReader } from './reader';
/** A CLI to answer for, and the `mcpConfig` block its own manifest declares. */
export type McpConfigTarget = {
    pluginId: string;
    spec: PluginMcpConfigSpec;
};
export type ResolvedMcpServers = {
    servers: AgentMcpServer[];
    diagnostics: CapabilityDiagnostic[];
};
export type McpServerResolver = {
    /** Keyed by `pluginId`; every target gets an entry, including empty ones. */
    resolve(input: {
        workspaceRoot: string;
        targets: readonly McpConfigTarget[];
    }): Promise<Map<string, ResolvedMcpServers>>;
};
export declare function createMcpServerResolver(options?: {
    readers?: ReadonlyMap<PluginMcpConfigFormat, McpConfigReader>;
    homeDir?: () => string;
}): McpServerResolver;
