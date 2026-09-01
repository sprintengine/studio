import type { SprintEngineMcpHubService } from '../sprintengine-mcp-hub';
import type { McpToolContribution } from '../module-host/main-host';
import { type McpToolRegistration } from '../../shared/modules/mcp-tools';
export declare function createStudioGatewayTools(options: {
    appTools: McpToolRegistration[];
    sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'callRunTool'>;
    /** Module-contributed tools, from the host kernel; empty until modules load. */
    resolveModuleTools: () => ReadonlyArray<McpToolContribution>;
    /** Live enablement of a contributing module; resolved per call, never captured. */
    isModuleEnabled: (moduleId: string) => boolean;
    warn?: (message: string) => void;
}): () => McpToolRegistration[];
export declare function isStudioGatewayMutation(toolName: string): boolean;
