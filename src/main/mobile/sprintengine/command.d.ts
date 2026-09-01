import { type SprintEngineToolExecutor } from './tool-runner';
export { MobileSprintEngineCommandError } from './command-error';
export { mobileControlProtocolVersion } from '../../../shared/mobile-control/protocol';
import type { MobileControlCommand, MobileControlCommandType, MobileControlError } from '../../../shared/mobile-control/protocol';
export type { MobileControlCommand, MobileControlCommandType, MobileControlError };
export type MobileSprintEngineTaskStartRequest = {
    sprintEngineId: string;
    statePath: string;
    teamDirectory: string;
    workspaceRoot: string;
    taskId: string;
    role: string;
    deviceId: string;
    commandId: string;
};
export type MobileSprintEngineTaskStartResult = {
    sessionId: string;
    agentId: string;
    executionMode: 'current_workspace' | 'worktree';
};
export type MobileSprintEngineFollowUpRequest = {
    sprintEngineId: string;
    statePath: string;
    teamDirectory: string;
    workspaceRoot: string;
    agentId: string;
    text: string;
    deviceId: string;
    commandId: string;
};
export type MobileSprintEngineFollowUpResult = {
    sessionId: string;
    agentId: string;
    acceptedAt: string;
};
export type SprintEngineAutomationMode = 'manual' | 'run_agents' | 'run_agents_and_approve_artifacts';
export type MobileSprintEngineSetAutomationModeRequest = {
    sprintEngineId: string;
    statePath: string;
    teamDirectory: string;
    workspaceRoot: string;
    mode: SprintEngineAutomationMode;
    deviceId: string;
    commandId: string;
};
export type MobileSprintEngineSetAutomationModeResult = {
    mode: SprintEngineAutomationMode;
    appliedAt: string;
};
export type MobileAutomationControlRequest = {
    workspaceRoot: string;
    automationId: string;
    deviceId: string;
    commandId: string;
};
export type MobileAutomationControlResult = {
    ok: true;
    value: MobileAutomationControlAccepted;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export type MobileAutomationControlAccepted = {
    automationId: string;
    status: 'enabled' | 'paused' | 'blocked';
    runId?: string;
    runStatus?: string;
};
export type MobileAutomationsController = {
    setStatus(request: MobileAutomationControlRequest & {
        status: 'enabled' | 'paused';
    }): Promise<MobileAutomationControlResult>;
    runNow(request: MobileAutomationControlRequest): Promise<MobileAutomationControlResult>;
};
export type MobileSprintEngineSessionOrchestrator = {
    startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult>;
    sendFollowUp(request: MobileSprintEngineFollowUpRequest): Promise<MobileSprintEngineFollowUpResult>;
    setAutomationMode?(request: MobileSprintEngineSetAutomationModeRequest): Promise<MobileSprintEngineSetAutomationModeResult>;
};
export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes';
export declare function buildSprintEngineArtifactReviewArgs(input: {
    statePath: string;
    action: SprintEngineArtifactReviewAction;
    artifactId: string;
    actorId: string;
    feedback?: string;
}): string[];
type MobileSprintEngineCommandServiceOptions = {
    workspaceRoot?: string;
    allowedWorkspaceRoots?: string[];
    statePaths?: string[];
    sprintEngineToolPath?: string;
    commandTtlMs?: number;
    now?: () => Date;
    execute?: SprintEngineToolExecutor;
    sessionOrchestrator?: MobileSprintEngineSessionOrchestrator;
    automationsController?: MobileAutomationsController;
    auditSink?: (entry: MobileSprintEngineCommandAuditEntry) => void;
};
export type MobileSprintEngineCommandDispatchOptions = {
    allowedWorkspaceRoots?: string[];
    statePaths?: string[];
};
export type MobileSprintEngineCommandAuditEntry = {
    auditId: string;
    commandId: string;
    commandType: MobileControlCommandType | 'unknown';
    deviceId: string | null;
    idempotencyKey?: string;
    status: 'accepted' | 'rejected' | 'failed';
    code?: MobileControlError['code'];
    message: string;
    recordedAt: string;
    statePath?: string;
    artifactId?: string;
    workspacePath?: string;
    toolArgs?: string[];
    exitCode?: number | null;
};
export type MobileSprintEngineCommandResult = {
    ok: true;
    commandId: string;
    commandType: MobileControlCommandType;
    idempotencyKey?: string;
    executedAt: string;
    data: unknown;
    stdout: string;
    stderr: string;
    audit: MobileSprintEngineCommandAuditEntry;
} | {
    ok: false;
    commandId: string | null;
    commandType: MobileControlCommandType | 'unknown';
    idempotencyKey?: string;
    error: MobileControlError;
    audit: MobileSprintEngineCommandAuditEntry;
};
export type MobileSprintEnginePullRequest = {
    repo: string;
    url: string;
    /** The project's name as a person says it; absent on a single-project run. */
    repoLabel?: string;
};
/**
 * The pull requests `vcs pr` opened, one per project the run delivered (MC-1612).
 *
 * The engine reports every project under `repos` and keeps the primary's url at the
 * top level, where every surface that predates the list still reads it. Read the list
 * when it is there and fall back to the flat field, so a run whose store predates the
 * list still yields its one pull request.
 *
 * Projects with no url are not pull requests and are not returned: a project the run
 * never committed to, or one whose open failed (the engine records the reason on that
 * repo's entry and never pairs it with a url). The phone reads why from the run
 * snapshot's per-repo state, which is where that already lives.
 */
export declare function pullRequestsFromVcsPr(data: unknown): MobileSprintEnginePullRequest[];
export declare class MobileSprintEngineCommandService {
    private readonly workspaceRoot;
    private readonly configuredAllowedWorkspaceRoots;
    private readonly configuredStatePaths;
    private readonly commandTtlMs;
    private readonly now;
    private readonly execute;
    private readonly sessionOrchestrator?;
    private readonly automationsController?;
    private readonly resultRecorder;
    constructor(options?: MobileSprintEngineCommandServiceOptions);
    getAuditLog(): MobileSprintEngineCommandAuditEntry[];
    dispatch(input: unknown, options?: MobileSprintEngineCommandDispatchOptions): Promise<MobileSprintEngineCommandResult>;
    private executeCommand;
    private executeTaskStartCommand;
    private executeAgentFollowUpCommand;
    private executeArtifactReviewCommand;
    private executeOpenPullRequestCommand;
    private executeSetAutomationModeCommand;
    private executeAutomationsControlCommand;
    private sprintEngineConfigArgs;
    private configuredRolesInitArgs;
    private executeSprintEngineCreateCommand;
    private executeBacklogUpdateCommand;
    private executeBacklogStartSprintEngineCommand;
    private executeBacklogCreateCommand;
    private commandScope;
    private workspaceRootCandidates;
    private resolveStateForSprintEngine;
    private invokeTool;
    private validateCommandTtl;
    private replayCachedResult;
}
