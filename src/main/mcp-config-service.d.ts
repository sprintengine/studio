import type { McpCatalogResult, McpCatalogServer, McpClientTarget, McpScope, McpSyncInput, McpSyncPreview, McpSyncResult } from '../shared/electron-api';
import type { PluginManifest, PluginMcpConfigSpec } from '../shared/plugin-manifest';
import { normalizeMcpClients, normalizeMcpServerConfig, type McpServerNormalizationOptions } from '../shared/mcp/normalize-server';
export { normalizeMcpClients, normalizeMcpServerConfig };
export type { McpServerNormalizationOptions };
export declare const MANAGED_SPRINTENGINE_MCP_SERVER_ID = "multicode-sprintengine";
export type PluginLookup = (id: string) => {
    manifest: PluginManifest;
} | undefined;
export type McpConfigService = {
    listCatalog(): McpCatalogResult;
    previewSync(input: McpSyncInput): McpSyncPreview;
    sync(input: McpSyncInput): McpSyncResult;
    removeManagedSprintEngine(input: McpManagedSprintEngineRemoveInput): McpSyncResult;
};
export type McpConfigServiceOptions = {
    lookupPlugin?: PluginLookup;
    homeDir?: () => string;
    userDataDir?: () => string;
    runtimeRoot?: () => string | null;
};
export declare function createMcpConfigService(options?: McpConfigServiceOptions): McpConfigService;
export type McpManagedSprintEngineRemoveInput = {
    workspaceRoot: string;
    clients?: McpClientTarget[];
};
export declare function findSprintEngineRuntimeRoot(): string | null;
export declare function normalizeCatalogServer(value: unknown): McpCatalogServer | null;
/**
 * The absolute path a plugin's declared MCP config template resolves to, or
 * null when the plugin declares none for that scope. The one place those
 * templates are substituted: the writers below and the read path
 * (src/main/mcp-config-readers/resolve-servers.ts) must agree byte for byte, or
 * the app would read a different file than it writes.
 */
export declare function resolveMcpConfigPath(spec: PluginMcpConfigSpec, scope: McpScope, workspaceRoot: string, homeDir: () => string): string | null;
