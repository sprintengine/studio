import type { AutomationDefinition, AutomationRun, AutomationRunEventTrigger, AutomationRunStatus, AutomationTriggerPollEvent, AutomationTriggerProvider, AutomationsRunEvent } from '../../shared/automations/contracts';
import type { AgentPhaseEvent } from '../../shared/agent-runtime';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import { AutomationsStore } from './store';
import type { AutomationPullRequestResult } from './pull-request';
import { type TriggerEventRunResult } from './trigger-event-runner';
export type AutomationsProjectFolder = {
    workspaceId: string;
    folderPath: string;
};
export type AutomationRunExecutionInput = {
    workspaceRoot: string;
    definition: AutomationDefinition;
    run: AutomationRun;
    triggerPayload: Record<string, unknown>;
    workspaceId?: string;
};
export type AutomationRunExecutor = (input: AutomationRunExecutionInput) => Promise<Partial<AutomationRun>>;
export type AutomationsEngineProblem = {
    workspaceRoot?: string;
    automationId?: string;
    code: string;
    message: string;
};
export type AutomationsEngineRunSummary = {
    workspaceRoot: string;
    automationId: string;
    runId: string;
    status: AutomationRunStatus;
};
export type AutomationsEngineEvaluationResult = {
    scheduled: {
        workspaceRoot: string;
        automationId: string;
        nextRunAt: string;
    }[];
    fired: AutomationsEngineRunSummary[];
    skipped: AutomationsEngineRunSummary[];
    droppedInFlight: {
        workspaceRoot: string;
        automationId: string;
    }[];
    problems: AutomationsEngineProblem[];
};
export type AutomationsEngineRunNowResult = {
    ok: true;
    definition: AutomationDefinition;
    run: AutomationRun;
} | {
    ok: false;
    problem: AutomationsEngineProblem;
};
export type AutomationsEngineTriggerEventDeliveryResult = {
    ok: true;
    definition: AutomationDefinition;
    delivery: Exclude<TriggerEventRunResult, {
        status: 'problem';
    }>;
} | {
    ok: false;
    problem: AutomationsEngineProblem;
};
export type AutomationsEngineFinalizeResult = {
    ok: true;
    run: AutomationRun;
} | {
    ok: false;
    problem: AutomationsEngineProblem;
};
export type AutomationRunPullRequestOpener = (input: {
    workspaceRoot: string;
    worktreePath: string;
    branch: string;
    title: string;
    body: string;
}) => Promise<AutomationPullRequestResult>;
export type AutomationRunWorktreeRemover = (input: {
    workspaceRoot: string;
    worktreePath: string;
}) => Promise<void>;
export type AutomationRunAgentDisposer = (input: {
    workspaceId: string;
    agentId: string;
}) => Promise<void>;
export type AutomationsEngineOptions = {
    getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>;
    getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>;
    createStore?: (workspaceRoot: string) => AutomationsStore;
    triggerProviders?: AutomationTriggerProvider[];
    getTriggerProviders?: () => AutomationTriggerProvider[];
    isIntegrationAvailable?: (id: string) => boolean | undefined;
    runAutomation: AutomationRunExecutor;
    now?: () => number;
    createRunId?: (input: {
        workspaceRoot: string;
        automationId: string;
        dueAt: string;
    }) => string;
    pollIntervalMs?: number;
    onEvaluation?: (result: AutomationsEngineEvaluationResult) => void;
    /**
     * Run-lifecycle event sink. `definition` is the automation the event belongs
     * to, handed through from the emit site so subscribers needing definition
     * metadata (e.g. `ownerModuleId` for module-scoped fan-out) never re-derive
     * it from the event's workspaceId — which can be the run-hosting workspace,
     * not the one whose store holds the definition.
     */
    onRunEvent?: (event: AutomationsRunEvent, definition: AutomationDefinition) => void;
    openRunPullRequest?: AutomationRunPullRequestOpener;
    removeRunWorktree?: AutomationRunWorktreeRemover;
    disposeRunAgent?: AutomationRunAgentDisposer;
    getLiveAgentExecutionIds?: () => string[];
    turnSettleMs?: number;
    readRunTranscriptSummary?: (transcriptPath: string) => Promise<string | undefined>;
    maxAgentRunMs?: number;
};
export declare class AutomationsEngine {
    private readonly getProjectFolders?;
    private readonly getWorkspaceSnapshot?;
    private readonly createStore;
    private readonly getTriggerProviders;
    private readonly isIntegrationAvailable?;
    private readonly runAutomation;
    private readonly now;
    private readonly createRunId;
    private readonly pollIntervalMs;
    private readonly onEvaluation?;
    private readonly onRunEvent?;
    private readonly openRunPullRequest?;
    private readonly removeRunWorktree?;
    private readonly disposeRunAgent?;
    private readonly getLiveAgentExecutionIds?;
    private readonly turnSettleMs;
    private readonly maxAgentRunMs;
    private readonly readRunTranscriptSummary;
    private readonly inFlight;
    private readonly pendingAgentRuns;
    private readonly finalizingRuns;
    private timer;
    private started;
    private startupEvaluation;
    private timerEvaluation;
    constructor(options: AutomationsEngineOptions);
    start(): void;
    stop(): void;
    isRunning(): boolean;
    handleStartup(): Promise<AutomationsEngineEvaluationResult>;
    tick(): Promise<AutomationsEngineEvaluationResult>;
    runNow(input: {
        workspaceRoot: string;
        automationId: string;
        workspaceId?: string;
        triggerPayload?: Record<string, unknown>;
    }): Promise<AutomationsEngineRunNowResult>;
    deliverTriggerEvent(input: {
        workspaceRoot: string;
        automationId: string;
        event: AutomationTriggerPollEvent;
        workspaceId?: string;
    }): Promise<AutomationsEngineTriggerEventDeliveryResult>;
    finalizeRun(input: {
        workspaceRoot: string;
        automationId: string;
        runId: string;
        outcome: 'completed' | 'failed';
        summary?: string;
        workspaceId?: string;
        eventTrigger?: AutomationRunEventTrigger;
    }): Promise<AutomationsEngineFinalizeResult>;
    noteAgentPhase(event: AgentPhaseEvent): Promise<void>;
    finalizeRunOnAgentExit(input: {
        executionId?: string;
        workspaceId?: string;
        agentId?: string;
        exitCode: number;
    }): Promise<void>;
    private finalizeArmedTurnEnd;
    private finalizeTurnEnd;
    private disarmTurnEnd;
    private finalizeRunLocked;
    private evaluate;
    private scanPendingAgentRuns;
    private reconcileOrphanedAgentRuns;
    private findPendingRunByExecutionId;
    private findPendingRunByAgent;
    private seedPendingAgentRuns;
    private trackPendingAgentRun;
    private pendingRunKey;
    private loadProjectFolders;
    private evaluateProject;
    private evaluateDefinition;
    private persistNextRun;
    private skipOverdueRun;
    private fireDueRun;
    private updateDefinitionAfterRun;
    private runRecord;
    private inFlightKey;
    private emitRunEvent;
    private resolveWorkspaceIdForRoot;
}
export declare function createAutomationsEngine(options: AutomationsEngineOptions): AutomationsEngine;
export declare function projectFoldersFromWorkspaceSyncSnapshot(snapshot: WorkspaceSyncSnapshot): AutomationsProjectFolder[];
