import type { AgentPhase, AgentStateSource, SessionActivity } from '../shared/electron-api';
import type { PluginAgentStateSpec } from '../shared/plugin-manifest';
export declare const AGENT_STATE_HOOK_TAG = "multicode-agent-state";
export declare const AGENT_STATE_HOOK_SCRIPT_REL: string;
export type AgentStateEventResolution = {
    action: 'drop';
} | {
    action: 'apply';
    phase: AgentPhase;
    turnEnd: boolean;
    turnFailure: boolean;
};
export declare function resolveAgentStateEvent(spec: PluginAgentStateSpec | null | undefined, frame: Pick<AgentStateFrame, 'event' | 'phase' | 'notificationType' | 'status'>): AgentStateEventResolution;
export declare function registeredAgentStateEvents(spec: Pick<PluginAgentStateSpec, 'events'>): Array<{
    event: string;
    matcher?: string;
}>;
export declare function isAtRestAgentPhase(phase: AgentPhase | null | undefined): boolean;
export declare function deriveActivityFromPhase(phase: AgentPhase, since: number): SessionActivity | null;
export type StallEvaluation = {
    action: 'stalled';
} | {
    action: 'recheck';
    afterMs: number;
} | {
    action: 'clear';
};
export declare function evaluateAgentStall(input: {
    phase: AgentPhase;
    source: AgentStateSource;
    phaseSince: number;
    lastOutputAt: number | null;
    now: number;
    thresholdMs: number;
}): StallEvaluation;
export type AgentStateFrameWakeup = {
    stop: true;
} | {
    delaySeconds: number;
};
export declare const MAX_WAKEUP_DELAY_SECONDS: number;
export declare const MAX_TRANSCRIPT_PATH_LENGTH = 4096;
export declare const MAX_AGENT_PROMPT_LENGTH = 2000;
export type AgentStateFrame = {
    type: 'agent_state';
    agentId: string;
    workspaceId: string | null;
    sessionId: string | null;
    phase?: AgentPhase;
    event: string | null;
    notificationType?: string;
    status?: string;
    ts: number;
    wakeup?: AgentStateFrameWakeup;
    transcriptPath?: string;
    prompt?: string;
};
export declare const MAX_NOTIFICATION_TYPE_LENGTH = 128;
export declare function parseAgentStateFrame(raw: unknown, now: number): AgentStateFrame | null;
export type AgentStateCandidate<T> = {
    value: T;
    agentId?: string;
    executionId?: string;
    sessionId?: string;
    workspaceId?: string;
    startedAt: number;
};
export declare function selectAgentStateTarget<T>(candidates: ReadonlyArray<AgentStateCandidate<T>>, frame: {
    agentId: string;
    workspaceId: string | null;
}): T | undefined;
export declare function buildAgentStateReporterCommand(scriptPath: string, socketPath: string): string;
export declare function mergeAgentStateHooks(settingsPath: string, command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): Promise<void>;
export declare function unmergeAgentStateHooks(settingsPath: string): Promise<void>;
export declare function mergeFlatAgentStateHooks(hooksPath: string, command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): Promise<void>;
export declare function unmergeFlatAgentStateHooks(hooksPath: string): Promise<void>;
export declare function renderTomlAgentStateHooksBlock(command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): string;
export declare function mergeTomlAgentStateHooks(previous: string, command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): string;
export declare function unmergeTomlAgentStateHooks(previous: string): string;
export declare function renderTomlArrayAgentStateHooksBlock(command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): string;
export declare function mergeTomlArrayAgentStateHooks(previous: string, command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): string;
export declare function renderOwnedJsonAgentStateHooksConfig(command: string, events: ReadonlyArray<{
    event: string;
    matcher?: string;
}>): string;
export declare function renderAgentStatePluginTemplate(template: string, socketPath: string): string;
export type AgentStateInstallResult = {
    ok: true;
    settingsPath: string;
    hookScriptPath: string;
} | {
    ok: false;
    message: string;
};
export declare function installAgentStateReporter(workspaceRoot: string, spec: PluginAgentStateSpec, options: {
    sourceScriptPath: string;
    socketPath: string;
    homeDir?: string;
}): Promise<AgentStateInstallResult>;
export declare function uninstallAgentStateReporter(workspaceRoot: string, spec: PluginAgentStateSpec, options?: {
    homeDir?: string;
}): Promise<{
    ok: true;
} | {
    ok: false;
    message: string;
}>;
