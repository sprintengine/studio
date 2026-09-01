import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch';
import type { ActionContext, AutomationActionProvider, AutomationRun } from '../../shared/automations/contracts';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../workspace-registry-service';
import type { WorkspaceMutationActor } from '../workspace-sync-service';
import type { AutomationRunExecutionInput, AutomationRunExecutor } from './engine';
import { type AutomationProviderPermissionChecker, type BuiltInAutomationProviderRegistryOptions, type RegisteredAutomationProvider } from './provider-registry';
export type LocalAutomationExecutorOptions = {
    /**
     * Compose and spawn the run's agent in main (MC-2159). This is the change
     * that makes an agent-backed automation run headless at all: the composition
     * used to live in a renderer hook, so a scheduled run with no window open
     * failed before it reached a pty. Every other outbound port here is a main
     * service too, so the executor asks a window for nothing (MC-2161).
     */
    launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult>;
    /**
     * Mint the run's automations-host workspace in main's registry (MC-2158).
     * The other half of headless: host creation used to be a renderer errand
     * too, and reuse of an existing host could only be guaranteed within one
     * window — main's single writer guarantees it across all of them.
     */
    createWorkspace(input: WorkspaceCreateRequest, actor: WorkspaceMutationActor): {
        ok: true;
        result: WorkspaceCreateResult;
    } | {
        ok: false;
        reason: string;
        message: string;
    };
    getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot;
    resolveAgentExecutionId?: (input: {
        workspaceId: string;
        agentId: string;
    }) => string | undefined;
    isIntegrationAvailable?: (id: string) => boolean | undefined;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    launchConfirmPollIntervalMs?: number;
    executionIdTimeoutMs?: number;
    actionProviders?: AutomationActionProvider[];
    getActionProviders?: () => AutomationActionProvider[];
    actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[];
    getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[];
    checkProviderPermission?: AutomationProviderPermissionChecker;
    createRunWorktree?: (input: {
        workspaceRoot: string;
        runId: string;
    }) => Promise<RunWorktree>;
    removeRunWorktree?: (input: {
        workspaceRoot: string;
        worktreePath: string;
    }) => Promise<void>;
};
export type RunWorktree = {
    worktreePath: string;
    branch: string;
};
export declare class AutomationActionBlockedError extends Error {
    readonly blockedReason: string;
    constructor(blockedReason: string);
}
export type RunWorktreeUnavailableReason = 'not_a_git_repository' | 'worktree_creation_failed';
export declare class RunWorktreeUnavailableError extends Error {
    readonly reason: RunWorktreeUnavailableReason;
    constructor(reason: RunWorktreeUnavailableReason, message: string);
}
export declare function createLocalAutomationExecutor(options: LocalAutomationExecutorOptions): AutomationRunExecutor;
export declare function createBuiltInAutomationActionProviders(options?: BuiltInAutomationProviderRegistryOptions): AutomationActionProvider[];
export declare function runLocalAutomationAction(input: AutomationRunExecutionInput, providers: AutomationActionProvider[], options: LocalAutomationExecutorOptions, registrations?: RegisteredAutomationProvider<AutomationActionProvider>[]): Promise<Partial<AutomationRun>>;
export declare function createActionContext(input: AutomationRunExecutionInput, options: LocalAutomationExecutorOptions, reportProgress: (patch: Partial<AutomationRun>) => void): ActionContext;
export declare function defaultCreateRunWorktree(input: {
    workspaceRoot: string;
    runId: string;
}): Promise<RunWorktree>;
export declare function defaultRemoveRunWorktree(input: {
    workspaceRoot: string;
    worktreePath: string;
}): Promise<void>;
