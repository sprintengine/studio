import type { McpCatalogResult, MemoryRootStatus, TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api';
import type { AgentDisposeRequest, AgentDisposeResult, AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch';
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings';
import type { TerminalSpawnPayload } from './ipc/terminal-ipc';
/** A workspace as the launch service needs to see it. */
export type AgentLaunchWorkspace = {
    id: string;
    mode?: string;
    folderPath?: string | null;
    agents?: Record<string, {
        name?: string;
    }>;
    /** Workspace-level Knowledge Graph override, below the per-project setting. */
    memory?: {
        relativeRoot?: string | null;
    } | null;
};
export type AgentLaunchServiceDeps = {
    /** Open workspaces, from the workspace-sync snapshot. */
    listWorkspaces: () => ReadonlyArray<AgentLaunchWorkspace>;
    /**
     * The main-owned launch settings (MC-2154): CLI runtimes, MCP servers, the
     * last-selected CLI, and the agent-spawn permission preset. Read at launch
     * time, never cached, so a setting changed in the UI reaches the next launch
     * without a restart.
     */
    getLaunchSettings: () => SprintEngineLaunchSettings;
    /** Main's own connector catalog (`mcpConfigService.listCatalog`). */
    listConnectorCatalog: () => McpCatalogResult;
    /**
     * Whether this CLI may launch as an agent: true exactly when its plugin
     * manifest declares an `agentStateSpec` (hooks are the only supported status
     * mechanism — decision of record 2026-08-31). This service is the shared door
     * for `agent.launch`, `backlog.work`, `terminal.create`, and automation
     * spawns, so gating here covers them all. Optional so bare test harnesses
     * keep working; production wiring always provides it.
     */
    isAgentSelectableCli?: (cli: string) => boolean;
    /**
     * Resolve a project's Knowledge Graph root on disk (`memory-graph.ts`'s
     * `resolveMemoryRoot`, the same call the renderer makes over IPC). Optional:
     * a host that cannot resolve one launches without the graph rather than
     * failing, which is what a project with no KG configured gets anyway.
     */
    resolveKnowledgeRoot?: (input: {
        workspaceRoot: string;
        relativeRoot: string;
    }) => Promise<MemoryRootStatus>;
    terminal: {
        list: () => TerminalSessionSnapshot[];
        spawn: (payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult>;
        kill: (sessionId: string) => void;
    };
    /** Session id minting. Injected so tests get stable ids; must be a UUID. */
    newSessionId?: () => string;
    /** Agent id suffix. Injected for the same reason. */
    newAgentSuffix?: () => string;
};
export type AgentLaunchService = {
    launch: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>;
    dispose: (request: AgentDisposeRequest) => AgentDisposeResult;
};
export declare function createAgentLaunchService(deps: AgentLaunchServiceDeps): AgentLaunchService;
