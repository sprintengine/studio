import type { SprintEngineArtifactCommandResult, SprintEngineMcpReadResult, SprintEngineProjectionReadResult, SprintEngineRegistryRoleReadInput, SprintEngineRegistryRolesReadInput, SprintEngineRosterRuntimeInput, SprintEngineRosterEnableInput, SprintEngineRunnerSetInput, SprintEngineStateInitializeInput, SprintEngineTaskCommentInput, SprintEngineTaskCreateInput, SprintEngineTaskResolveInput, SprintEngineTaskStatusSetInput, SprintEngineTaskUpdateInput, SprintEngineTaskWorktreeInput, SprintEngineTaskWorktreeResult } from '../shared/electron-api';
import type { SprintEngineArtifactOpenPayload, SprintEngineArtifactReviewAction, SprintEngineArtifactReviewMode, SprintEngineArtifactReviewPayload, SprintEngineProjectionReadPayload, SprintEngineVcsMergePayload, SprintEngineVcsPayload } from './ipc/sprintengine-ipc';
import { SPRINT_ENGINE_RUN_SCHEMA_VERSION, describeUnsupportedSprintEngineStore } from '../shared/sprintengine/store-schema';
export { SPRINT_ENGINE_RUN_SCHEMA_VERSION, describeUnsupportedSprintEngineStore };
type SprintEngineArtifactDependencies = {
    getAuthenticatedUserId(): string | null;
    openExternal(url: string): Promise<void>;
    runMcpTool?: SprintEngineMcpToolRunner;
};
type SprintEngineMcpActorContext = {
    id: string;
    role: 'user' | 'renderer';
    authenticated: true;
    mcpAuthorized: true;
};
type SprintEngineMcpToolResponse = {
    ok: true;
    tool: string;
    result: unknown;
} | {
    ok: false;
    tool: string;
    error?: {
        code?: string;
        message?: string;
    };
};
type SprintEngineMcpRunnerContext = {
    workspaceRoot: string;
    allowedRoots?: string[];
    timeoutMs?: number;
};
type SprintEngineMcpToolRunner = (context: SprintEngineMcpRunnerContext, tool: string, payload: Record<string, unknown>, actor: SprintEngineMcpActorContext) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    response: SprintEngineMcpToolResponse | null;
}>;
type SprintEngineArtifactRecord = {
    id: string;
    kind: string;
    title: string;
    path: string;
    status: string;
    createdBy: string;
    taskId: string;
};
type SprintEngineTaskRecord = {
    id: string;
    status: string;
    ownerAgentId: string;
};
/**
 * The other projects a run declares, as absolute roots (MC-1611).
 *
 * A Sprint Engine session may reach exactly the projects its run declared, and the
 * primary one is already every caller's workspace root — so this returns only what a
 * caller does not already hold: entries after entry zero. A single-project run
 * declares none, so its allowed surface is unchanged from before runs could span
 * projects.
 *
 * Read from `projection.json`, which carries the `vcs` block verbatim: it is the
 * app's machine-readable view of the store, and a run's repo set is fixed at
 * creation, so it cannot go stale under a reader. Anything unreadable, unresolvable,
 * or reaching outside a real sibling directory yields nothing rather than a wider
 * surface — the declaration is the only thing that widens it.
 */
export declare function sprintEngineDeclaredSiblingRepoRoots(statePath: string): string[];
/**
 * What a session launching in `launchCwd` is bound to: the declared repo whose
 * tree it sits in (MC-1610), and — under per-task isolation — the one task whose
 * own worktree that is (MC-2136).
 *
 * This is what binds a session's MCP token, so its `task.next` only offers work
 * that lives in the tree it is actually sitting in. Derived from the launch cwd
 * rather than passed down from the scheduler: the cwd is the thing that makes
 * the binding true, and reading it here keeps the one authority in the same
 * place the allowed roots are derived from. A single-repo run's worktree matches
 * its primary entry, so its sessions bind to `primary` and see every task — the
 * pre-multi-repo behavior.
 *
 * Task trees are checked FIRST: a task worktree is not a repo worktree, so a
 * session in one would otherwise read as bound to nothing at all. Its repo comes
 * from the task, which is the authority on the project that task works in.
 */
export declare function sprintEngineSessionBindingForLaunchCwd(statePath: string, launchCwd: string): {
    repo: string | null;
    taskId: string | null;
};
/** The repo half of {@link sprintEngineSessionBindingForLaunchCwd}. */
export declare function sprintEngineRepoIdForLaunchCwd(statePath: string, launchCwd: string): string | null;
/**
 * Registry roles for a workspace, outside the IPC handler bag (mobile snapshot).
 *
 * Bounded, unlike the renderer's read: this one runs on the snapshot publish path,
 * where a hung Python child would stall every snapshot the phone ever gets.
 */
export declare function readSprintEngineRegistryRoles(payload: SprintEngineRegistryRolesReadInput, timeoutMs?: number): Promise<SprintEngineMcpReadResult>;
export declare function getArtifactAutoApprovalBlocker(artifact: SprintEngineArtifactRecord, tasks: SprintEngineTaskRecord[], artifacts: SprintEngineArtifactRecord[]): string | null;
export declare function createSprintEngineArtifactHandlers(deps: SprintEngineArtifactDependencies): {
    openArtifact(payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult>;
    reviewArtifact(payload: SprintEngineArtifactReviewPayload, action: SprintEngineArtifactReviewAction, mode: SprintEngineArtifactReviewMode): Promise<SprintEngineArtifactCommandResult>;
    initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>;
    updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>;
    createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>;
    commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>;
    resolveTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>;
    setTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>;
    setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>;
    cancelRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    createPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    mergePullRequest(payload: SprintEngineVcsMergePayload): Promise<SprintEngineArtifactCommandResult>;
    refreshPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    ensureTaskWorktree(payload: SprintEngineTaskWorktreeInput): Promise<SprintEngineTaskWorktreeResult>;
    setRoleRuntime(payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult>;
    enableRole(payload: SprintEngineRosterEnableInput): Promise<SprintEngineArtifactCommandResult>;
    readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>;
    readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>;
    readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>;
    summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>;
};
