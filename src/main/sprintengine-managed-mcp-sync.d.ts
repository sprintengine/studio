import type { McpConfigService } from './mcp-config-service';
import type { SprintEngineMcpHubService } from './sprintengine-mcp-hub';
import type { McpSyncInput } from '../shared/electron-api';
export type ManagedSprintEngineMcpSyncResult = {
    ok: true;
    managedSprintEngineRunId?: string;
    runTokenEnv?: Record<string, string>;
} | {
    ok: false;
    message: string;
};
export declare const MANAGED_SPRINTENGINE_MCP_RUN_TOKEN_ENV_VAR = "MULTICODE_SPRINTENGINE_MCP_RUN_TOKEN";
export declare const MANAGED_SPRINTENGINE_MCP_RUN_ID_ENV_VAR = "MULTICODE_SPRINTENGINE_MCP_RUN_ID";
export declare const MANAGED_STUDIO_MCP_SERVER_ID = "sprintengine-studio";
export declare function syncManagedSprintEngineMcpConfig(input: McpSyncInput, deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>;
    sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'ensureStarted' | 'ensureRunRegistered' | 'unregisterRun'>;
    studioGateway?: () => {
        command: string;
        bridgeScriptPath: string;
        userDataDir: string;
    };
}): Promise<ManagedSprintEngineMcpSyncResult>;
