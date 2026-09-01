import { type WebContents } from 'electron';
import type { AgentCli, AgentExecutionMode, McpSettings, TerminalSessionSnapshot, TerminalSpawnResult } from '../shared/electron-api';
import type { AgentPhaseListener, AgentSessionExitListener, AgentSpawnDescriptor, LiveAgentExecution } from '../shared/agent-runtime';
import { type AgentStateFrame } from './agent-state';
import type { TerminalSpawnPayload } from './ipc/terminal-ipc';
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc';
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command';
import { type DetectAgentCliAvailabilityDeps } from './cli-availability';
import { type TerminalRemoteHost } from './terminal-remote-attach';
import { type SubtreeProbeDeps } from './terminal-subtree-probe';
import type { TerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar';
import type { DesktopMobileSprintEngineSessionAdapters } from './mobile/sprintengine/session';
import type { TerminalRootInfo } from './workspace-memory';
type TerminalRuntimeOptions = {
    diagnosticsEnabled: boolean;
    requireAuthenticatedUser(message: string): void;
    logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void;
    syncMcpConfig?(input: {
        workspaceRoot: string;
        settings: McpSettings;
        clients: AgentCli[];
        pruneUnlistedServers?: boolean;
        managedSprintEngine?: {
            statePath: string;
            workspaceRoot?: string;
            allowedRoots?: string[];
            registryRoots?: string[];
            userRoot?: string;
            actorId?: string;
            workspaceId?: string;
            agentId?: string;
            role?: string;
            repo?: string;
            /** The one task this session may work, when its cwd is that task's own
             *  worktree (MC-2136). Absent on shared-worktree runs. */
            taskId?: string;
            cli?: AgentCli;
            knowledgeRoot?: string;
            http?: {
                url: string;
                authTokenEnvVar?: string;
                headers?: Record<string, string>;
            };
        };
    }): Promise<{
        ok: true;
        managedSprintEngineRunId?: string;
        runTokenEnv?: Record<string, string>;
    } | {
        ok: false;
        message: string;
    }>;
    releaseManagedSprintEngineRun?(input: {
        runId: string;
        workspaceRoot: string;
        clients: AgentCli[];
        cleanupMcpConfig: boolean;
    }): Promise<void> | void;
    callManagedSprintEngineTool?(input: {
        runId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
    }): Promise<unknown>;
    ensureBuiltinSkillInstalled?(workspaceRoot: string, skillId: string): Promise<void>;
    excludeWorktreeMcpConfig?(worktreePath: string): Promise<void>;
    prepareAgentStateHook?(workspaceRoot: string, cli: string): Promise<void>;
    snapshotSidecars?: TerminalSnapshotSidecarStore;
    logDiagnostic?(input: {
        level: 'info' | 'warning';
        title: string;
        message: string;
        details?: string;
        workspaceId?: string;
        agentId?: string;
        sessionId?: string;
    }): void;
    setSprintEngineAutomationMode?: DesktopMobileSprintEngineSessionAdapters['setSprintEngineAutomationMode'];
    resolveAutomationsFrontDoor?: () => AutomationsAppFrontDoor | null;
};
type TerminalIpcHandlers = {
    spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>;
    writeTerminal(sessionId: string, data: string): void;
    resizeTerminal(sessionId: string, cols: number, rows: number): void;
    getTerminalStatus(sessionId: string, sender?: WebContents): Promise<{
        processAlive: boolean;
        suspended: boolean;
    }>;
    listTerminals(): TerminalSessionSnapshot[];
    setTerminalVisible(sessionId: string, visible: boolean, sender?: WebContents): void;
    suspendTerminal(sessionId: string): void;
    resumeTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>;
    killTerminal(sessionId: string): void;
    setIdleSuspendThresholdMs(value: unknown): void;
    setKeepRecentTerminalsAlive(value: unknown): void;
    setTerminalReapExempt(sessionId: string, exempt: boolean): void;
    setActiveSprintRunStatePaths(value: unknown): void;
};
type TerminalRuntime = {
    commandService: MobileSprintEngineCommandService;
    ipcHandlers: TerminalIpcHandlers;
    shutdown(): Promise<void>;
    getLiveAgentExecutionIds(): LiveAgentExecution[];
    resolveAgentExecutionId(input: {
        workspaceId: string;
        agentId: string;
    }): string | undefined;
    /** Move a sprint run's sessions onto the workspace id that owns them; returns how many moved. */
    adoptSprintRunWorkspaceId(input: {
        statePath: string;
        workspaceId: string;
    }): number;
    registerAgentSessionExitListener(listener: AgentSessionExitListener): () => void;
    registerAgentPhaseListener(listener: AgentPhaseListener): () => void;
    killAgentSession(input: {
        workspaceRoot: string;
        executionId: string;
    }): void;
    spawnAgentSession(input: {
        workspaceId?: string;
        workspaceRoot: string;
        descriptor: AgentSpawnDescriptor;
        mcpSettings?: McpSettings;
    }): Promise<TerminalSpawnResult>;
    ingestAgentStateFrame(frame: AgentStateFrame): void;
    readTerminalOutput(sessionId: string): string | undefined;
    remoteHost: TerminalRemoteHost;
};
export declare function cliResumeCapabilities(cli: string | undefined): {
    resumeSession: boolean;
    sessionIdFromCaller: boolean;
};
export declare const SPRINTENGINE_AGENT_HEARTBEAT_INTERVAL_MS: number;
/**
 * A sprint agent's worktree gets the managed Sprint Engine server plus every
 * connector the user enabled (the sprint wizard's Tools step and the
 * Connectors surface both write `enabled` + `syncEnabled`). Enabled servers
 * are extended to the launching CLI even when their client list doesn't name
 * it: the per-server client list scopes plain workspace syncs, but a sprint
 * provisions whichever CLIs the roster actually runs. Disabled servers stay in
 * the map as known-but-inactive so stale managed entries are pruned from the
 * worktree config.
 */
export declare function mcpSettingsForManagedSprintEngineLaunch(settings: McpSettings | undefined, cli: AgentCli): McpSettings;
/**
 * Run registration must authorize the run store, not just the terminal cwd:
 * worktree-mode agents launch in
 * `<root>/.multi-code/sprintengine/<run>/worktree` while `run.yaml` lives in
 * that directory's parent, so registering the launch cwd as the workspace
 * root rejects the statePath (HTTP 400 invalid_run_registration: statePath
 * is outside allowedRoots). Mirror the MCP server's own
 * `_default_workspace_root` derivation: the project root is the parent of
 * the `.multi-code` segment the state path lives under, falling back to the
 * launch cwd for non-standard layouts.
 */
export declare function deriveSprintEngineRegistrationRoot(statePath: string, launchCwd: string): string;
export declare function buildManagedSprintEngineSyncInputForLaunch(statePath: string, launchCwd: string, launch?: {
    workspaceId?: string;
    agentId?: string;
    role?: string;
    cli?: AgentCli;
    knowledgeRoot?: string;
}): NonNullable<Parameters<NonNullable<TerminalRuntimeOptions['syncMcpConfig']>>[0]['managedSprintEngine']>;
export declare function sprintEngineRegistryRootsForLaunch(): string[];
export declare function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime;
/**
 * The event sink for a main-process spawn. A live window streams output to the
 * UI immediately; with every window closed the headless sender stands in — the
 * sender is an event sink, not a capability, so the pty still runs and buffers,
 * and a window opened later reattaches through `spawnTerminalFromIpc`'s
 * existing-session branch, adopting the real WebContents and replaying
 * scrollback. The one definition for every main-process spawn: the descriptor
 * and mobile `task.start` spawns below, and the sprint scheduler's spawn port
 * in `src/main/app-services.ts`.
 */
export declare function resolveSpawnEventSink(): WebContents;
export declare function suspendTerminal(sessionId: string): void;
export declare const STALE_TERMINAL_SWEEP_INTERVAL_MS: number;
export declare function setIdleSuspendThresholdMs(value: unknown): void;
export declare function getIdleSuspendThresholdMs(): number;
export declare function setKeepRecentTerminalsAlive(value: unknown): void;
export declare function getKeepRecentTerminalsAlive(): number;
type AgentCliPreflightTestOverrides = {
    deps?: DetectAgentCliAvailabilityDeps;
    platform?: NodeJS.Platform;
    shell?: string;
};
export declare function __setAgentCliPreflightForTest(overrides: AgentCliPreflightTestOverrides | null): void;
export declare function setTerminalReapExempt(sessionId: string, exempt: boolean): void;
export declare function setActiveSprintRunStatePaths(value: unknown): void;
export declare function reapStaleTerminals(now?: number, guardHolds?: ReadonlyMap<string, string>, probedSessionIds?: ReadonlySet<string>): string[];
export declare function runIdleAgentReapSweep(now?: number, guardHolds?: ReadonlyMap<string, string>, probedSessionIds?: ReadonlySet<string>): string[];
export declare function runGuardedTerminalReapSweeps(now?: number, deps?: {
    subtree?: SubtreeProbeDeps;
}): Promise<{
    staleReaped: string[];
    idleReaped: string[];
}>;
export declare function listTerminalRoots(): TerminalRootInfo[];
export declare function sendSprintEngineAgentHeartbeats(): Promise<string[]>;
declare function spawnMobileAgentTerminal(input: {
    sessionId: string;
    cwd: string;
    sprintEngineStatePath: string;
    agentId: string;
    role: string;
    initialPrompt: string;
    cli: AgentCli;
    executionMode: AgentExecutionMode;
    worktreeId?: string;
    worktreePath?: string;
}): Promise<{
    ok: true;
    sessionId: string;
} | {
    ok: false;
    message: string;
}>;
/**
 * Test seam for the mobile `task.start` spawn. In production it is reachable
 * only as the mobile command service's `spawnAgentTerminal` adapter, whose
 * dispatch path needs a paired device, a scoped workspace root, and a real run
 * projection — none of which the spawn behavior under test depends on.
 */
export declare const __spawnMobileAgentTerminalForTest: typeof spawnMobileAgentTerminal;
export {};
