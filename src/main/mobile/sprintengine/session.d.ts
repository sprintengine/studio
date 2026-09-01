import { type MobileSprintEngineFollowUpRequest, type MobileSprintEngineFollowUpResult, type MobileSprintEngineSessionOrchestrator, type MobileSprintEngineSetAutomationModeRequest, type MobileSprintEngineSetAutomationModeResult, type MobileSprintEngineTaskStartRequest, type MobileSprintEngineTaskStartResult } from './command';
import type { TerminalSessionSnapshot as CanonicalTerminalSessionSnapshot } from '../../../shared/electron-api';
type AgentCli = string;
type TerminalSessionSnapshot = Pick<CanonicalTerminalSessionSnapshot, 'sessionId' | 'processAlive' | 'kind' | 'agentId' | 'cli' | 'sprintEngineStatePath' | 'executionMode' | 'worktreeId' | 'worktreePath'>;
type SpawnMobileAgentTerminalInput = {
    sessionId: string;
    cwd: string;
    sprintEngineStatePath: string;
    agentId: string;
    role: string;
    initialPrompt: string;
    cli: AgentCli;
    executionMode: 'current_workspace' | 'worktree';
};
type SpawnMobileAgentTerminalResult = {
    ok: true;
    sessionId: string;
} | {
    ok: false;
    message: string;
};
export type SetSprintEngineAutomationModeInput = {
    sprintEngineId: string;
    statePath: string;
    workspaceRoot: string;
    mode: MobileSprintEngineSetAutomationModeRequest['mode'];
    deviceId?: string;
};
export type SetSprintEngineAutomationModeResult = {
    ok: true;
} | {
    ok: false;
    retryable: boolean;
    message: string;
};
export type DesktopMobileSprintEngineSessionAdapters = {
    listTerminals(): Promise<TerminalSessionSnapshot[]>;
    spawnAgentTerminal(input: SpawnMobileAgentTerminalInput): Promise<SpawnMobileAgentTerminalResult>;
    writeTerminal(sessionId: string, data: string): Promise<void> | void;
    setSprintEngineAutomationMode?(input: SetSprintEngineAutomationModeInput): Promise<SetSprintEngineAutomationModeResult>;
};
type DesktopMobileSprintEngineSessionOptions = {
    adapters: DesktopMobileSprintEngineSessionAdapters;
    maxProcessAliveAgentTerminals?: number;
    now?: () => Date;
};
export declare class DesktopMobileSprintEngineSessionOrchestrator implements MobileSprintEngineSessionOrchestrator {
    private readonly options;
    private readonly maxProcessAliveAgentTerminals;
    private readonly now;
    constructor(options: DesktopMobileSprintEngineSessionOptions);
    startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult>;
    sendFollowUp(request: MobileSprintEngineFollowUpRequest): Promise<MobileSprintEngineFollowUpResult>;
    setAutomationMode(request: MobileSprintEngineSetAutomationModeRequest): Promise<MobileSprintEngineSetAutomationModeResult>;
}
export {};
