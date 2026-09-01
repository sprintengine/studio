import type { SwitchboardAgentSpawnDescriptor, SwitchboardRunnerResult, SwitchboardRunnerStartInput, SwitchboardStopExecutionInput, SwitchboardStopExecutionResult } from '../shared/switchboard';
import type { McpSettings } from '../shared/electron-api';
type SwitchboardSessionSpawner = (input: {
    workspaceId?: string;
    workspaceRoot: string;
    descriptor: SwitchboardAgentSpawnDescriptor;
    mcpSettings?: McpSettings;
}) => Promise<{
    ok: true;
    sessionId: string;
} | {
    ok: false;
    message: string;
}>;
type SwitchboardSessionStopper = (input: {
    workspaceRoot: string;
    executionId: string;
}) => void;
type SwitchboardRuntimeInventoryProvider = (workspaceRoot: string) => string[];
export declare function stopAllSwitchboardRunnerLoops(): void;
export declare function beginSwitchboardPythonRuntimeShutdown(): void;
export declare function shutdownSwitchboardPythonRuntime(): Promise<void>;
export declare function stopSpawnedWatchtowerSessions(workspaceRoot: string, descriptors: SwitchboardAgentSpawnDescriptor[], message: string): Promise<void>;
export declare function spawnSwitchboardAgentSession(input: {
    workspaceId?: string;
    workspaceRoot: string;
    descriptor: SwitchboardAgentSpawnDescriptor;
    mcpSettings?: McpSettings;
}): Promise<{
    ok: true;
    sessionId: string;
} | {
    ok: false;
    message: string;
} | undefined>;
export declare function configureSwitchboardSessionSpawner(spawner: SwitchboardSessionSpawner): void;
export declare function configureSwitchboardSessionStopper(stopper: SwitchboardSessionStopper): void;
export declare function configureSwitchboardExecutionStopper(stopper: SwitchboardSessionStopper): void;
export declare function configureSwitchboardRuntimeInventoryProvider(provider: SwitchboardRuntimeInventoryProvider): void;
export declare function recordSwitchboardSessionExit(input: {
    workspaceRoot: string;
    workspaceId?: string;
    executionId: string;
    exitCode: number;
}): Promise<void>;
export declare function startSwitchboardRunner(input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult>;
export declare function pauseSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>;
export declare function resumeSwitchboardRunner(input: {
    workspaceRoot: string;
    workspaceId?: string;
    mcpSettings?: McpSettings;
}): Promise<SwitchboardRunnerResult>;
export declare function stopSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult>;
export declare function tickSwitchboardRunner(input: {
    workspaceRoot: string;
    workspaceId?: string;
    mcpSettings?: McpSettings;
}): Promise<SwitchboardRunnerResult>;
export declare function getSwitchboardRunnerState(input?: string | {
    workspaceRoot?: string;
    mcpSettings?: McpSettings;
}): Promise<SwitchboardRunnerResult>;
export declare function stopSwitchboardRunnerAndExecutions(workspaceRoot: string): Promise<SwitchboardRunnerResult>;
export declare function stopSwitchboardExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult>;
export {};
