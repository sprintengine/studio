import type { McpToolContribution } from './module-host/main-host';
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc';
import type { RoadmapAppFrontDoor } from './roadmap-orchestrator';
import { MulticodeAuthBridge } from './auth-service';
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command';
import type { BackgroundStatus } from '../shared/background-mode';
import { ConversationRuntime } from './conversation-runtime';
import { MulticodeUpdateService } from './update-service';
import { GitHubTokenStore } from './github-token-store';
export declare function createAppServices(diagnosticsEnabled: boolean): {
    agentConfigImportService: import("./agent-config-import").AgentConfigImportService;
    agentStateService: {
        initialize: () => Promise<void>;
        shutdown: () => Promise<void>;
        getSocketPath: () => string;
        installForWorkspace: (workspaceRoot: string, cli: string) => Promise<void>;
        isRunning: () => boolean;
    };
    sprintCreateService: {
        createSprint(request: import("../shared/sprint-create").SprintCreateRequest): Promise<import("../shared/sprint-create").SprintCreateResult>;
    };
    automationService: {
        initialize: () => Promise<import("../shared/automation").AutomationServerStatus>;
        getStatus: () => import("../shared/automation").AutomationServerStatus;
        setEnabled: (_next: boolean) => Promise<import("../shared/automation").AutomationServerStatus>;
        shutdown: () => Promise<void>;
        notifyToolsListChanged: () => void;
        getTailnetStatus: () => import("../shared/tailnet").TailnetRemoteStatus;
        setTailnetEnabled: (next: boolean) => Promise<import("../shared/tailnet").TailnetRemoteStatus>;
        offerTailnetPairing: (input?: {
            scopes?: unknown;
        }) => import("../shared/tailnet").TailnetPairingOfferView;
        cancelTailnetPairing: () => import("../shared/tailnet").TailnetRemoteStatus;
        revokeTailnetDevice: (deviceId: string) => import("../shared/tailnet").TailnetRemoteStatus;
        listTailnetPeers: () => Promise<import("../shared/tailnet-peers").TailnetPeerScan>;
        fleet: () => import("./automation/tailnet/tailnet-fleet-service").TailnetFleetService;
    };
    backgroundModeStore: {
        isEnabled(): boolean;
        set(enabled: boolean): void;
    };
    readBackgroundStatus: () => BackgroundStatus;
    setAutomationsAppFrontDoorResolver(resolver: () => AutomationsAppFrontDoor | null): void;
    getAutomationsAppFrontDoor: () => AutomationsAppFrontDoor | null;
    setRoadmapAppFrontDoorResolver(resolver: () => RoadmapAppFrontDoor | null): void;
    setModuleEnabledResolver(resolver: (moduleId: string) => boolean): void;
    setModuleMcpToolsResolver(resolver: () => ReadonlyArray<McpToolContribution>): void;
    moduleRegistryMirror: import("./modules/registry-mirror").ModuleRegistryMirror;
    agentControlPlane: import("./agent-control-plane").AgentControlPlane;
    agentLaunchService: import("./agent-launch-service").AgentLaunchService;
    builtinSkillManager: {
        list: () => Promise<import("../shared/electron-api").BuiltinSkill[]>;
        getStatus: (workspaceRoot: string | null, skillId: string) => Promise<import("../shared/electron-api").BuiltinSkillStatus>;
        install: (workspaceRoot: string | null, skillId: string) => Promise<import("../shared/electron-api").BuiltinSkillInstallResult>;
    };
    conversationRuntime: ConversationRuntime;
    githubTokenStore: GitHubTokenStore;
    logMainPerfEvent: (scope: string, event: string, payload: Record<string, unknown>) => void;
    mcpConfigService: import("./mcp-config-service").McpConfigService;
    multicodeAuth: MulticodeAuthBridge;
    entitlements: import("./entitlement-service").EntitlementService;
    skillsService: import("./skills").SkillsService;
    sprintEngineArtifacts: {
        openArtifact(payload: import("./ipc/sprintengine-ipc").SprintEngineArtifactOpenPayload): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        reviewArtifact(payload: import("./ipc/sprintengine-ipc").SprintEngineArtifactReviewPayload, action: import("./ipc/sprintengine-ipc").SprintEngineArtifactReviewAction, mode: import("./ipc/sprintengine-ipc").SprintEngineArtifactReviewMode): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        initializeSprintEngineState(payload: import("../shared/electron-api").SprintEngineStateInitializeInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        updateTask(payload: import("../shared/electron-api").SprintEngineTaskUpdateInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        createTask(payload: import("../shared/electron-api").SprintEngineTaskCreateInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        commentTask(payload: import("../shared/electron-api").SprintEngineTaskCommentInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        resolveTaskInput(payload: import("../shared/electron-api").SprintEngineTaskResolveInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        setTaskStatus(payload: import("../shared/electron-api").SprintEngineTaskStatusSetInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        setRunnerMode(payload: import("../shared/electron-api").SprintEngineRunnerSetInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        cancelRun(payload: import("./ipc/sprintengine-ipc").SprintEngineVcsPayload): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        createPullRequest(payload: import("./ipc/sprintengine-ipc").SprintEngineVcsPayload): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        mergePullRequest(payload: import("./ipc/sprintengine-ipc").SprintEngineVcsMergePayload): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        refreshPullRequestStatus(payload: import("./ipc/sprintengine-ipc").SprintEngineVcsPayload): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        ensureTaskWorktree(payload: import("../shared/electron-api").SprintEngineTaskWorktreeInput): Promise<import("../shared/electron-api").SprintEngineTaskWorktreeResult>;
        setRoleRuntime(payload: import("../shared/electron-api").SprintEngineRosterRuntimeInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        enableRole(payload: import("../shared/electron-api").SprintEngineRosterEnableInput): Promise<import("../shared/electron-api").SprintEngineArtifactCommandResult>;
        readProjection(payload: import("./ipc/sprintengine-ipc").SprintEngineProjectionReadPayload): Promise<import("../shared/electron-api").SprintEngineProjectionReadResult>;
        readRegistryRoles(payload: import("../shared/electron-api").SprintEngineRegistryRolesReadInput): Promise<import("../shared/electron-api").SprintEngineMcpReadResult>;
        readRegistryRole(payload: import("../shared/electron-api").SprintEngineRegistryRoleReadInput): Promise<import("../shared/electron-api").SprintEngineMcpReadResult>;
        summarizeFeedback(payload: import("./ipc/sprintengine-ipc").SprintEngineProjectionReadPayload): Promise<import("../shared/electron-api").SprintEngineMcpReadResult>;
    };
    sprintEngineAutomation: {
        readAutomationMode(input: {
            statePath: string;
        }): Promise<import("../shared/electron-api").SprintEngineAutomationReadResult>;
        setAutomationMode(input: import("./sprintengine-automation-service").SetSprintEngineAutomationModeInput): Promise<import("../shared/electron-api").SprintEngineAutomationWriteResult>;
        setCliPermissionPreset(input: import("./sprintengine-automation-service").SetSprintEngineCliPermissionPresetInput): Promise<import("../shared/electron-api").SprintEngineAutomationWriteResult>;
        updateRuntimeResidue(input: {
            statePath: string;
            runtime: import("../shared/sprintengine/automation-intent").SprintEngineAutomationRuntimeResidue;
        }): Promise<void>;
        hydrateAutomationMode(input: {
            statePath: string;
            mode: import("../shared/sprintengine/automation-types").SprintEngineAutomationMode;
        }): Promise<import("../shared/electron-api").SprintEngineAutomationWriteResult>;
    };
    sprintEngineLaunchSettings: {
        get(): import("../shared/sprintengine/launch-settings").SprintEngineLaunchSettings;
        getRecord(): import("../shared/sprintengine/launch-settings").SprintEngineLaunchSettingsRecord | null;
        set(raw: unknown): import("./sprintengine-launch-settings-mirror").SprintEngineLaunchSettingsWriteResult;
        hydrate(raw: unknown): import("./sprintengine-launch-settings-mirror").SprintEngineLaunchSettingsWriteResult;
        subscribe(listener: (settings: import("../shared/sprintengine/launch-settings").SprintEngineLaunchSettings) => void): () => void;
    };
    sprintEngineMcpHub: import("./sprintengine-mcp-hub").GatedSprintEngineMcpHubService;
    sprintPowerManager: {
        markRunActive(statePath: string): void;
        markRunInactive(statePath: string): void;
        isHolding(): boolean;
        activeRunCount(): number;
        shutdown(): void;
    };
    sprintPullRequestMergePoller: import("./sprintengine-pr-merge-poller").SprintPullRequestMergePoller;
    sprintRuntime: {
        resolveRunnerLogTarget(workspaceId: string): {
            statePath: string;
            folderPath: string | null;
        } | null;
        registerRun(registration: import("./sprint-runtime").SprintRuntimeRunRegistration): void;
        adoptAutomationRecord(statePath: string, record: import("../shared/sprintengine/automation-intent").SprintEngineAutomationIntentRecord): void;
        unregisterRun(statePath: string): void;
        applyResume(statePath: string): void;
        resumeIfBlocked(statePath: string): void;
        cancelRun(statePath: string): void;
        applyStopReason(push: import("./sprint-runtime").SprintRuntimeStopReasonPush): void;
        notifyAutomationChanged(statePath: string, record: import("../shared/sprintengine/automation-intent").SprintEngineAutomationIntentRecord): void;
        listRuns(): Array<{
            statePath: string;
            name: string;
            autoRunning: boolean;
        }>;
        inspectRun(statePath: string): {
            view: import("../shared/sprintengine/run-types").SprintEngineWorkspaceView;
            rosterSessions: Record<string, import("../shared/sprintengine/run-types").SprintEngineRosterSession>;
        } | null;
        tickNow(): Promise<void>;
        shutdown(): void;
    };
    trackerWriteBack: import("./tracker/writeback").TrackerWriteBackRuntime;
    terminalRuntime: {
        commandService: MobileSprintEngineCommandService;
        ipcHandlers: {
            spawnTerminal(sender: Electron.CrossProcessExports.WebContents, payload: import("./ipc/terminal-ipc").TerminalSpawnPayload): Promise<import("../shared/electron-api").TerminalSpawnResult>;
            writeTerminal(sessionId: string, data: string): void;
            resizeTerminal(sessionId: string, cols: number, rows: number): void;
            getTerminalStatus(sessionId: string, sender?: Electron.CrossProcessExports.WebContents): Promise<{
                processAlive: boolean;
                suspended: boolean;
            }>;
            listTerminals(): import("../shared/electron-api").TerminalSessionSnapshot[];
            setTerminalVisible(sessionId: string, visible: boolean, sender?: Electron.CrossProcessExports.WebContents): void;
            suspendTerminal(sessionId: string): void;
            resumeTerminal(sender: Electron.CrossProcessExports.WebContents, payload: import("./ipc/terminal-ipc").TerminalSpawnPayload): Promise<import("../shared/electron-api").TerminalSpawnResult>;
            killTerminal(sessionId: string): void;
            setIdleSuspendThresholdMs(value: unknown): void;
            setKeepRecentTerminalsAlive(value: unknown): void;
            setTerminalReapExempt(sessionId: string, exempt: boolean): void;
            setActiveSprintRunStatePaths(value: unknown): void;
        };
        shutdown(): Promise<void>;
        getLiveAgentExecutionIds(): import("../shared/agent-runtime").LiveAgentExecution[];
        resolveAgentExecutionId(input: {
            workspaceId: string;
            agentId: string;
        }): string | undefined;
        adoptSprintRunWorkspaceId(input: {
            statePath: string;
            workspaceId: string;
        }): number;
        registerAgentSessionExitListener(listener: import("../shared/agent-runtime").AgentSessionExitListener): () => void;
        registerAgentPhaseListener(listener: import("../shared/agent-runtime").AgentPhaseListener): () => void;
        killAgentSession(input: {
            workspaceRoot: string;
            executionId: string;
        }): void;
        spawnAgentSession(input: {
            workspaceId?: string;
            workspaceRoot: string;
            descriptor: import("../shared/agent-runtime").AgentSpawnDescriptor;
            mcpSettings?: import("../shared/electron-api").McpSettings;
        }): Promise<import("../shared/electron-api").TerminalSpawnResult>;
        ingestAgentStateFrame(frame: import("./agent-state").AgentStateFrame): void;
        readTerminalOutput(sessionId: string): string | undefined;
        remoteHost: import("./terminal-remote-attach").TerminalRemoteHost;
    };
    updateService: MulticodeUpdateService;
    withIpcDiagnostics: <T>(scope: string, event: string, payload: Record<string, unknown>, action: () => Promise<T>) => Promise<T>;
    workspaceBackupService: import("./workspace-backup").WorkspaceBackupService;
    workspaceSkillsService: import("./workspace-skills-service").WorkspaceSkillsService;
    agentCapabilityService: import("./workspace-skills-service").AgentCapabilityService;
    agentSkillInstaller: import("./agent-skill-installer").AgentSkillInstaller;
    capabilityWatcher: import("./capability-watcher").CapabilityWatcher;
    workspaceSyncService: {
        adoptWorkspace: (workspace: import("../renderer/src/types/workspace").Workspace, windowId: string, folderPath: string | null, actor: import("./workspace-sync-service").WorkspaceMutationActor) => import("../shared/workspace-sync").WorkspaceSyncCommandResult;
        createWorkspace: (input: import("./workspace-registry-service").WorkspaceCreateRequest, actor: import("./workspace-sync-service").WorkspaceMutationActor) => {
            ok: true;
            result: import("./workspace-registry-service").WorkspaceCreateResult;
        } | {
            ok: false;
            reason: string;
            message: string;
        };
        dispatch: (input: {
            command: unknown;
            sourceWindowId: string;
        }) => import("../shared/workspace-sync").WorkspaceSyncCommandResult;
        flush: () => Promise<void>;
        getEventsAfter: (sequence: unknown) => import("../shared/workspace-sync").WorkspaceSyncEvent[];
        getSnapshot: () => import("../shared/workspace-sync").WorkspaceSyncSnapshot;
        removeWorkspace: (workspaceId: import("../renderer/src/types/workspace").WorkspaceId, actor: import("./workspace-sync-service").WorkspaceMutationActor) => import("../shared/workspace-sync").WorkspaceSyncCommandResult;
        subscribeEvents: (listener: (event: import("../shared/workspace-sync").WorkspaceSyncEvent) => void) => () => void;
        updateWorkspaceAgent: (workspaceId: import("../renderer/src/types/workspace").WorkspaceId, agentId: string, patch: Partial<import("../shared/sprintengine/agent-state").AgentState> | null, actor: import("./workspace-sync-service").WorkspaceMutationActor) => import("../shared/workspace-sync").WorkspaceSyncCommandResult;
        updateWorkspaceFields: (workspaceId: import("../renderer/src/types/workspace").WorkspaceId, patch: import("../shared/workspace-sync").WorkspaceFieldsPatch, actor: import("./workspace-sync-service").WorkspaceMutationActor) => import("../shared/workspace-sync").WorkspaceSyncCommandResult;
    };
    workspaceRegistry: {
        getState: () => import("../shared/workspace-sync").WorkspaceSyncState;
        getRecords: () => import("../shared/workspace-registry").WorkspaceRegistryRecord[];
        getRecord: (workspaceId: import("../renderer/src/types/workspace").WorkspaceId) => import("../shared/workspace-registry").WorkspaceRegistryRecord | null;
        getRevision: () => number;
        newWorkspaceId: () => string;
        getTombstones: () => import("../shared/workspace-registry").WorkspaceRegistryTombstone[];
        applyEvent: (event: import("../shared/workspace-sync").WorkspaceSyncEvent, actor: import("../shared/workspace-registry").WorkspaceRegistryActor) => boolean;
        precheckCommand: (command: import("../shared/workspace-sync").WorkspaceSyncCommand) => import("./workspace-registry-service").WorkspaceRegistryPrecheck;
        prepareCreate: (input: import("./workspace-registry-service").WorkspaceCreateRequest) => import("./workspace-registry-service").WorkspaceCreateResult;
        adoptRecord: (workspace: import("../renderer/src/types/workspace").Workspace) => import("../shared/workspace-registry").WorkspaceRegistryRecord;
        hydrate: (payload: import("./workspace-registry-service").WorkspaceRegistryHydratePayload) => import("./workspace-registry-service").WorkspaceRegistryHydrateResult;
        needsHydration: () => boolean;
        subscribe: (listener: (state: import("../shared/workspace-sync").WorkspaceSyncState) => void) => () => void;
        flush: () => Promise<void>;
    };
};
export type AppServices = ReturnType<typeof createAppServices>;
