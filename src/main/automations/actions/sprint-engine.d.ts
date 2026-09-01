import type { SprintCreateRequest, SprintCreateResult } from '../../../shared/sprint-create';
import type { AutomationActionProvider } from '../../../shared/automations/contracts';
import type { SprintEngineArtifactCommandResult, SprintEngineProjectionReadResult, SprintEngineRunnerSetInput } from '../../../shared/electron-api';
export declare const SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID = "module:sprint-engine";
export declare const SPRINT_ENGINE_RUN_ACTION_KIND = "sprint-engine-run";
export declare const SPRINT_ENGINE_START_ACTION_KIND = "sprint-engine-start";
export type SprintEngineAutomationFrontDoors = {
    setRunnerMode(input: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>;
    /**
     * Read a run's projection.json — the sanctioned read surface for run state
     * (never run-store internals). Used by the `sprint-engine.run-landed` trigger.
     */
    readProjection(input: {
        statePath: string;
        knownToken?: string;
    }): Promise<SprintEngineProjectionReadResult>;
    /**
     * Idempotent `vcs pr-status` refresh for a run's declared repos, so landed
     * detection does not depend on the renderer's PR sweeps. Read-only on the tree.
     */
    refreshPullRequestStatus(input: {
        statePath: string;
    }): Promise<SprintEngineArtifactCommandResult>;
    /**
     * Merge one project's delivered pull request (`vcs pr-merge`). The engine
     * re-probes state, enforces merge order, and is idempotent. Used by the
     * roadmap orchestrator's `merge: auto` advance (MC-1619).
     */
    mergePullRequest(input: {
        statePath: string;
        repo?: string;
    }): Promise<SprintEngineArtifactCommandResult>;
};
export declare function createSprintEngineRunActionProvider(frontDoors: SprintEngineAutomationFrontDoors): AutomationActionProvider;
export type SprintEngineStartActionDeps = {
    /**
     * Main's sprint-creation service (MC-2160). A chained sprint no longer needs a
     * window: creation composes in-process and the scheduler bootstraps the
     * coordinator, so an unattended 02:00 chain starts the same as an attended one.
     */
    createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>;
    /**
     * Fetch the checkout's upstream and return the freshly-updated remote-tracking
     * ref of the current branch (e.g. `origin/main`), or null when there is no
     * upstream to refresh from (the run then branches from the local base, which
     * is all there is). MUST throw when an upstream exists but the fetch fails —
     * silently proceeding would chain the sprint onto a stale base, the exact
     * defect this plumbing prevents. Injected for tests; defaults to real git.
     */
    resolveBaseStartPoint?(workspaceRoot: string): Promise<string | null>;
};
/**
 * Start the next sprint from a chosen backlog item (MC-1438): the `sprint-engine.
 * run-landed` trigger's companion action, composing with `disableAfterRun` for
 * "chain once" pipelines. The chained run always bases on the refreshed base
 * branch — after a merge on GitHub the local checkout is typically stale, so the
 * action fetches first and passes the remote-tracking ref as the worktree START
 * POINT while the PR base stays the plain branch name.
 *
 * The sprint owns its own worktree and PR lifecycle, so this action never calls
 * `ctx.spawnAgent` and the automations per-run worktree/PR wrapper never engages
 * (same posture as `sprint-engine-run`). The automation run finalizes `completed`
 * at successful launch; the sprint's own lifecycle is tracked by sprint-engine
 * surfaces, not automations run history.
 *
 * Chained sprints are SINGLE-PROJECT in v1: the config declares no sibling
 * repos, so the refreshed start point only ever applies to the primary repo —
 * `ensure_run_worktree`'s primary-only `start_point` gating is deliberately
 * sufficient. Extending chaining to multi-repo runs needs a per-repo fetch and
 * per-repo start points first.
 */
export declare function createSprintEngineStartActionProvider(deps: SprintEngineStartActionDeps): AutomationActionProvider;
