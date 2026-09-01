import { type RoadmapLaneRuntime, type RoadmapRunLifecycle } from '../shared/sprintengine/roadmap-orchestrator';
import { type RoadmapAdvancePolicy, type RoadmapItemState, type RoadmapPolicy } from '../shared/backlog/roadmap';
import type { SprintEngineCliPermissionPreset } from '../shared/electron-api';
import { type RoadmapBoardLane, type RoadmapLaneStateView, type RoadmapStateView } from '../shared/sprintengine/roadmap-surface';
export type RoadmapRunRef = {
    statePath: string;
    teamSlug: string;
};
export type RoadmapRunSnapshot = {
    mode: 'worktree' | 'shared';
    lifecycle: RoadmapRunLifecycle;
    prAllMerged?: boolean;
    prClosedUnmerged?: boolean;
};
export type RoadmapBacklogItem = {
    relativePath: string;
    status: RoadmapItemState['status'];
    dependsOn?: string[];
    isRoadmap?: boolean;
    isEpic?: boolean;
    epic?: string;
    numericId?: number;
    title?: string;
};
export type RoadmapActor = 'user' | 'automation';
export type RoadmapAuditEntry = {
    at: string;
    actor: RoadmapActor;
    action: 'approve' | 'merge' | 'pause' | 'resume' | 'add_step' | 'remove_step' | 'reorder' | 'skip' | 'create' | 'configure';
    roadmapRef: string;
    lane?: string;
    ref?: string;
    detail?: string;
};
export type RoadmapBoardView = {
    roadmapRef: string;
    title?: string;
    lanes: RoadmapBoardLane[];
};
export type RoadmapConfirmation = 'replan_delivered_run';
export type RoadmapCommandOutcome = {
    ok: boolean;
    message?: string;
    ref?: string;
    confirm?: RoadmapConfirmation;
};
export type RoadmapSteerAction = 'approve' | 'merge' | 'pause' | 'resume';
export type RoadmapMergeOutcome = {
    ok: boolean;
    message?: string;
    repo?: string;
    branch?: string;
};
export type RoadmapItemOutcome = 'delivered' | 'skipped';
export type RoadmapResumeOptions = {
    replanDeliveredRun?: boolean;
};
export type RoadmapAppFrontDoor = {
    readBoard(): Promise<RoadmapBoardView | null>;
    addStep(input: {
        ref: string;
        projectPath?: string;
        lane?: string;
        actor?: RoadmapActor;
    }): Promise<RoadmapCommandOutcome>;
    removeStep(input: {
        ref: string;
        actor?: RoadmapActor;
    }): Promise<RoadmapCommandOutcome>;
    reorderStep(input: {
        ref: string;
        toIndex: number;
        toLane?: string;
        actor?: RoadmapActor;
    }): Promise<RoadmapCommandOutcome>;
    skipStep(input: {
        ref: string;
        reason: string;
        actor?: RoadmapActor;
    }): Promise<RoadmapCommandOutcome>;
    steerLane(lane: string, action: RoadmapSteerAction, actor: RoadmapActor, options?: RoadmapResumeOptions): Promise<RoadmapCommandOutcome>;
    createHorizon(input: {
        name: string;
        projectRoot?: string;
        steps?: ReadonlyArray<string>;
        policy?: Partial<RoadmapPolicy>;
        start?: boolean;
        actor?: RoadmapActor;
    }): Promise<{
        ok: true;
        roadmapRef: string;
        advance: RoadmapAdvancePolicy;
        steps: string[];
        policy: RoadmapPolicy;
    } | {
        ok: false;
        message: string;
    }>;
    configureHorizon(input: {
        policy: Partial<RoadmapPolicy>;
        actor?: RoadmapActor;
    }): Promise<RoadmapCommandOutcome & {
        policy?: RoadmapPolicy;
    }>;
    reconcile(): Promise<void>;
};
export type RoadmapLaneView = RoadmapLaneStateView;
export type RoadmapView = RoadmapStateView;
export type RoadmapOrchestratorPorts = {
    getHomeProjectRoot(): string | null;
    listWorkspaceRoots(): string[];
    listBacklogItems(workspaceRoot: string): Promise<RoadmapBacklogItem[]>;
    readRoadmapFile(workspaceRoot: string, relativePath: string): Promise<string | null>;
    writeRoadmapFile(workspaceRoot: string, relativePath: string, content: string): Promise<void>;
    deleteRoadmapFile(workspaceRoot: string, relativePath: string): Promise<void>;
    appendAudit(roadmapRef: string, entry: RoadmapAuditEntry): Promise<void>;
    resolveExecutionLink(workspaceRoot: string, itemRelativePath: string): Promise<RoadmapRunRef | null>;
    observeRun(runRef: RoadmapRunRef): Promise<RoadmapRunSnapshot | null>;
    mergePullRequest(statePath: string): Promise<RoadmapMergeOutcome>;
    readRunItemOutcomes(runRef: RoadmapRunRef): Promise<Map<string, RoadmapItemOutcome>>;
    setBacklogStatus(workspaceRoot: string, itemRelativePath: string, status: 'completed'): Promise<void>;
    startSprint(input: {
        workspaceRoot: string;
        itemRelativePath: string;
        isEpic: boolean;
        roster?: string;
        agent?: string;
        permissionPreset: SprintEngineCliPermissionPreset;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
    abandonRun(workspaceRoot: string, itemRelativePath: string, teamSlug: string | undefined): Promise<void>;
    readLaneRuntime(roadmapRef: string, legacyRoots?: ReadonlyArray<string>): Promise<Map<string, RoadmapLaneRuntime>>;
    writeLaneRuntime(roadmapRef: string, lanes: ReadonlyMap<string, RoadmapLaneRuntime>): Promise<void>;
    notify(input: {
        severity: 'info' | 'warning' | 'error';
        title: string;
        body?: string;
    }): void;
    logDiagnostic(input: {
        level: 'info' | 'warning' | 'error';
        title: string;
        message: string;
    }): void;
    now(): Date;
};
export type RoadmapOrchestrator = ReturnType<typeof createRoadmapOrchestrator>;
export declare function createRoadmapOrchestrator(ports: RoadmapOrchestratorPorts): {
    reconcile: () => Promise<void>;
    approveStart: (roadmapRef: string, lane: string, actor?: RoadmapActor) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    mergeLane: (roadmapRef: string, lane: string, actor?: RoadmapActor) => Promise<RoadmapCommandOutcome>;
    resumeLane: (roadmapRef: string, lane: string, actor?: RoadmapActor, options?: RoadmapResumeOptions) => Promise<RoadmapCommandOutcome>;
    pauseLane: (roadmapRef: string, lane: string, actor?: RoadmapActor) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    readRoadmapStates: () => Promise<RoadmapView[]>;
    readBoard: () => Promise<RoadmapBoardView | null>;
    addStep: (input: {
        ref: string;
        projectPath?: string;
        lane?: string;
        actor?: RoadmapActor;
    }) => Promise<{
        ok: boolean;
        message?: string;
        ref?: string;
    }>;
    removeStep: (input: {
        ref: string;
        actor?: RoadmapActor;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    reorderStep: (input: {
        ref: string;
        toIndex: number;
        toLane?: string;
        actor?: RoadmapActor;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    skipStep: (input: {
        ref: string;
        reason: string;
        actor?: RoadmapActor;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    activateRoadmap: (input: {
        roadmapRef: string;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    createRoadmap: (input: {
        projectRoot: string;
        name: string;
    }) => Promise<{
        ok: true;
        roadmapRef: string;
        projectRoot: string;
    } | {
        ok: false;
        message: string;
    }>;
    deleteRoadmap: (input: {
        roadmapRef: string;
    }) => Promise<{
        ok: boolean;
        message?: string;
    }>;
    createHorizon: (input: {
        name: string;
        projectRoot?: string;
        steps?: ReadonlyArray<string>;
        policy?: Partial<RoadmapPolicy>;
        start?: boolean;
        actor?: RoadmapActor;
    }) => Promise<{
        ok: true;
        roadmapRef: string;
        advance: RoadmapAdvancePolicy;
        steps: string[];
        policy: RoadmapPolicy;
    } | {
        ok: false;
        message: string;
    }>;
    configureHorizon: (input: {
        policy: Partial<RoadmapPolicy>;
        actor?: RoadmapActor;
    }) => Promise<RoadmapCommandOutcome & {
        policy?: RoadmapPolicy;
    }>;
    steerLane: (lane: string, action: RoadmapSteerAction, actor: RoadmapActor, options?: RoadmapResumeOptions) => Promise<RoadmapCommandOutcome>;
};
