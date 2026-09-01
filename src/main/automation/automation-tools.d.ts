import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import type { SprintEngineArtifactCommandResult, SprintEngineAutomationReadResult, SprintEngineAutomationWriteResult, SprintEngineCliPermissionPreset, SprintEngineProjectionReadResult, SprintEngineTaskCommentInput, SprintEngineTaskCreateInput, SprintEngineTaskResolveInput, SprintEngineTaskStatusSetInput, SprintEngineTaskUpdateInput, TerminalSessionSnapshot } from '../../shared/electron-api';
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage';
import type { SetSprintEngineAutomationModeInput } from '../sprintengine-automation-service';
import type { SprintEngineArtifactReviewAction, SprintEngineArtifactReviewPayload, SprintEngineVcsPayload } from '../ipc/sprintengine-ipc';
import type { SprintCreateRequest, SprintCreateResult } from '../../shared/sprint-create';
import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch';
import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts';
import type { BacklogAddOrUpdateLinkInput, BacklogDependenciesPlannedInput, BacklogEpicInput, BacklogMutationResult, BacklogStatusInput, BacklogTriageInput, BacklogTypeInput } from '../../shared/electron-api';
import type { BacklogIntegrityRepairInput, BacklogIntegrityRepairResult, BacklogListItemsResult, BacklogReadItemResult } from '../backlog-service';
import type { AutomationStoreListResult } from '../automations/store';
import type { AutomationsAppFrontDoor } from '../ipc/automations-ipc';
import type { RoadmapAppFrontDoor } from '../roadmap-orchestrator';
import type { LoadedPlugin } from '../../shared/plugin-manifest';
import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api';
import { type ThirdPartyModuleListResult } from '../../shared/modules/manifest';
import type { ModuleRegistrySnapshot } from '../../shared/modules/registry-snapshot';
import type { McpToolRegistration } from './mcp-socket-server';
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../workspace-registry-service';
import type { WorkspaceMutationActor } from '../workspace-sync-service';
export type AutomationBackends = {
    getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot;
    listTerminalSessions(): TerminalSessionSnapshot[];
    /** Compose and spawn an agent in main (MC-2159). */
    launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult>;
    /**
     * This machine's own agent-spawn permission preset, from the main-owned
     * launch settings store (MC-2154); `null` when the user has never chosen one.
     *
     * Read by `terminal.create` so a remotely-opened terminal runs under the
     * preset the person at this machine chose — and read HERE rather than left to
     * the launch service, because the surface's `bypass_all` ceiling has to be
     * applied before the pty exists, not after. The CLI default needs no such
     * accessor: the launch service resolves it from the same store and says so
     * when there is none.
     */
    getAgentSpawnPermissionDefault(): SprintEngineCliPermissionPreset | null;
    /**
     * Mint a workspace in main's registry (MC-2158). Synchronous and
     * window-independent: `workspace.create` no longer asks a renderer to build
     * the record and then polls the bus to see whether it appeared.
     */
    createWorkspace(input: WorkspaceCreateRequest, actor: WorkspaceMutationActor): {
        ok: true;
        result: WorkspaceCreateResult;
    } | {
        ok: false;
        reason: string;
        message: string;
    };
    /**
     * Create a Sprint Engine run in main (MC-2160). Like `createWorkspace`, this
     * needs no window: the run is composed, its workspace adopted into the
     * registry, and the scheduler's run-start bootstrap spawns the coordinator.
     */
    createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>;
    /** Read-only backlog listing for a workspace root (files + frontmatter, no writes). */
    listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>;
    /** Read one backlog item (validated backlog/ relative path). */
    readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>;
    /** Automation definitions from the workspace's .multi-code/automations store. */
    listAutomationDefinitions(workspaceRoot: string): Promise<AutomationStoreListResult<AutomationDefinition>>;
    /** Run history for one automation, newest-first (store-capped). */
    listAutomationRuns(workspaceRoot: string, automationId: string): Promise<AutomationStoreListResult<AutomationRun>>;
    /** Backlog write services (main-owned file/store writers in backlog-service). */
    backlogWrite: BacklogWriteBackends;
    /**
     * The Automations module's IPC-equivalent create/run-now pipeline, resolved
     * lazily (the module kernel boots after the automation server's tools are
     * constructed). Null while the Automations module is disabled or not yet
     * loaded — tools report that explicitly instead of buffering.
     */
    getAutomationsFrontDoor(): AutomationsAppFrontDoor | null;
    /**
     * The instance roadmap's read + plan + steer surface (MC-1693), resolved lazily
     * like the Automations front door (the orchestrator boots with the Automations
     * module, after these tools are constructed). Null while that module is disabled
     * or not yet loaded — the horizon.* tools report that explicitly.
     */
    getRoadmapFrontDoor(): RoadmapAppFrontDoor | null;
    /** Absolute run.yaml paths under <root>/.multi-code/sprintengine, newest first. */
    listSprintRunStatePaths(workspaceRoot: string): Promise<string[]>;
    /** One run's projection.json via the sprint-engine artifact reader (main-owned). */
    readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>;
    /**
     * Read a run's main-owned automation mode intent (`automation.json` beside
     * run.yaml). Injected so sprint.status can disclose the mode an orchestrator
     * cannot otherwise see. A `record` of null means no sidecar exists yet, which
     * the board treats as `manual`.
     */
    readSprintAutomationMode(input: {
        statePath: string;
    }): Promise<SprintEngineAutomationReadResult>;
    /**
     * Write a run's automation mode through the main-owned intent service (the
     * `sprint.status`/mobile-relay write path, not the renderer delegate — the
     * two-lane rule). Same-mode writes return `changed: false`.
     */
    setSprintAutomationMode(input: SetSprintEngineAutomationModeInput): Promise<SprintEngineAutomationWriteResult>;
    /**
     * Re-arm a stopped scheduler for the run's current mode (the board's Resume).
     * Fire-and-forget: returns void and no-ops on a run the scheduler does not
     * hold; callers verify via sprint.status.
     */
    resumeSprintRun(statePath: string): void;
    /**
     * Cancel a run: the composed operation the IPC channel uses — the engine
     * cancel op, then (on success) scheduler teardown so a paused/manual run with
     * live agents is also torn down. Composed at the wiring site.
     */
    cancelSprintRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    /**
     * Sprint steering (MC-1654), all main-owned `sprintEngineArtifacts` writes —
     * the two-lane rule, never the renderer delegate. Each returns a result
     * object and never throws; a `{ ok: false }` is surfaced as the tool's own
     * `_failed` code. Review mode is pinned `'user'` at the wiring site: external
     * callers are a human-proxy surface, never the auto-runner's `'auto-run'`.
     */
    reviewSprintArtifact(payload: SprintEngineArtifactReviewPayload, action: SprintEngineArtifactReviewAction): Promise<SprintEngineArtifactCommandResult>;
    commentSprintTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>;
    resolveSprintTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>;
    setSprintTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>;
    createSprintTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>;
    updateSprintTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>;
    /**
     * Sprint VCS + usage reads (MC-1655), main-owned like the steering block. PR
     * create/refresh run the engine's own `vcs` CLI (idempotent per the command)
     * and re-read the projection into the result `data`; a `{ ok: false }` carries
     * the CLI stdout/stderr the caller needs. `readSprintTokenUsage` computes the
     * report directly — it never throws, degrading to an empty/unmeasured report.
     */
    createSprintPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    refreshSprintPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>;
    readSprintTokenUsage(statePath: string): Promise<SprintEngineTokenUsageReport>;
    /**
     * Create a git worktree for a widened agent.launch (model/preset/specialist
     * launches that request isolation, and every connector launch). Worktree
     * creation is renderer-adjacent but git-bound, so it happens in main before
     * delegating — the automations executor precedent. Returns the created
     * absolute path + branch, or `{ error }` (non-git folder, name collision,
     * git failure) which the tool surfaces as `worktree_unavailable`. Injected as
     * a backend so tests fake it.
     */
    createAgentWorktree(input: {
        workspaceRoot: string;
        name: string;
    }): Promise<{
        worktreePath: string;
        branch: string;
    } | {
        error: string;
    }>;
    /**
     * Loaded CLI plugin manifests (`getPluginRegistry().loaded()`). backlog.work
     * composes the target CLI's native skill invocation from the matching
     * plugin's `skillIntegration.invocation.fileDropTemplate`; injected as a
     * backend so tests fake manifests.
     */
    listPlugins(): LoadedPlugin[];
    /**
     * Make a built-in skill present in the workspace's native harness dirs before
     * a launch reads its invocation (getStatus → install; the
     * `ensureBuiltinSkillInstalled` seam in app-services). Returns whether the
     * skill is now installed. A false result is non-fatal for backlog.work — the
     * response records `skillEnsured: false` and the composed prompt still states
     * the lifecycle contract.
     */
    ensureBuiltinSkillInstalled(workspaceRoot: string, skillId: string): Promise<boolean>;
    /**
     * The module registry as the renderer resolves it (MC-2078), mirrored into
     * main. Null until a window has pushed one — the module tools report that
     * explicitly rather than answering from main's own half of the universe,
     * which knows nothing about renderer-only modules (Backlog, Design, Git, …).
     */
    getModuleRegistrySnapshot(): ModuleRegistrySnapshot | null;
    /**
     * Installed third-party modules with the trust + launch readiness only main
     * can compute (signature verification and the trust store live here). An
     * untrusted module never reaches the renderer registry, so this is also how
     * `module.list` sees that it is installed at all.
     */
    listInstalledThirdPartyModules(): Promise<ThirdPartyModuleListResult>;
    /** Gateway tools contributed by capability modules, by owner (MC-1855). */
    listModuleContributedTools(): ReadonlyArray<{
        moduleId: string;
        toolName: string;
    }>;
    /**
     * The marketplace registry index through the same client, cache, and
     * bundled-first policy the Extensions storefront reads (`marketplace:registry:read`)
     * — one source of truth, not a second fetch path.
     */
    readMarketplaceRegistry(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>;
    /**
     * The mobile companion's read model and command lane, served over the
     * gateway so a tailnet-paired phone works without the relay
     * (tailnet-mobile-transport, self-hosted-relay epic). Snapshots come back
     * in the same path-token form the relay serves — the phone round-trips
     * `ws_` tokens, never local paths — and commands run through the same
     * MobileSprintEngineCommandService the relay bridge dispatches to, so the
     * two transports cannot drift in behaviour.
     */
    mobileControl: {
        readSnapshot(input: {
            include?: string[];
            knownSnapshotVersion?: string;
        }): Promise<{
            unchanged: true;
            snapshotVersion: string;
        } | {
            unchanged: false;
            snapshot: Record<string, unknown>;
        }>;
        dispatchCommand(input: {
            type: string;
            payload: Record<string, unknown>;
            deviceId: string;
            idempotencyKey: string;
            expectedSnapshotVersion?: string;
        }): Promise<{
            ok: true;
            commandId: string;
            commandType: string;
            executedAt: string;
            data: unknown;
        } | {
            ok: false;
            code: string;
            message: string;
        }>;
    };
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};
export type BacklogWriteBackends = {
    updateStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>;
    updateType(input: BacklogTypeInput): Promise<BacklogMutationResult>;
    updateTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>;
    updateEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>;
    updateDependenciesPlanned(input: BacklogDependenciesPlannedInput): Promise<BacklogMutationResult>;
    addOrUpdateLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>;
    repairIntegrity(input: BacklogIntegrityRepairInput): Promise<BacklogIntegrityRepairResult>;
};
export declare function createAutomationTools(backends: AutomationBackends): McpToolRegistration[];
