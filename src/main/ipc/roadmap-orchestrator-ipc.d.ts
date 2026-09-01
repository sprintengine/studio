import type { IpcMain } from 'electron';
import type { RoadmapConfirmation, RoadmapOrchestrator, RoadmapView } from '../roadmap-orchestrator';
export declare const ROADMAP_STATES_READ_CHANNEL = "roadmap:states:read";
export declare const ROADMAP_LANE_APPROVE_CHANNEL = "roadmap:lane:approve";
export declare const ROADMAP_LANE_MERGE_CHANNEL = "roadmap:lane:merge";
export declare const ROADMAP_LANE_RESUME_CHANNEL = "roadmap:lane:resume";
export declare const ROADMAP_LANE_PAUSE_CHANNEL = "roadmap:lane:pause";
export declare const ROADMAP_HOME_GET_CHANNEL = "roadmap:home:get";
export declare const ROADMAP_HOME_SET_CHANNEL = "roadmap:home:set";
export declare const ROADMAP_ACTIVATE_CHANNEL = "roadmap:activate";
export declare const ROADMAP_SKIP_STEP_CHANNEL = "roadmap:step:skip";
export declare const ROADMAP_CREATE_CHANNEL = "roadmap:create";
export declare const ROADMAP_DELETE_CHANNEL = "roadmap:delete";
export type RoadmapLaneCommandPayload = {
    roadmapRef: string;
    lane: string;
};
export type RoadmapResumePayload = RoadmapLaneCommandPayload & {
    replanDeliveredRun?: boolean;
};
export type RoadmapCommandResult = {
    ok: boolean;
    message?: string;
    confirm?: RoadmapConfirmation;
};
export type RoadmapStatesReadResult = {
    ok: true;
    roadmaps: RoadmapView[];
} | {
    ok: false;
    message: string;
};
export type RoadmapHomeResult = {
    path: string | null;
};
export type RoadmapHomeSetPayload = {
    path: string | null;
};
export type RoadmapActivatePayload = {
    roadmapRef: string;
};
export type RoadmapDeletePayload = {
    roadmapRef: string;
};
export type RoadmapSkipStepPayload = {
    ref: string;
    reason: string;
};
export type RoadmapCreatePayload = {
    projectRoot: string;
    name: string;
};
export type RoadmapCreateResult = {
    ok: true;
    roadmapRef: string;
} | {
    ok: false;
    message: string;
};
export type RoadmapHomePorts = {
    getHomeProjectPath(): string | null;
    setHomeProjectPath(path: string | null): Promise<void>;
};
export declare function registerRoadmapOrchestratorIpc(ipcMain: IpcMain, orchestrator: RoadmapOrchestrator, home: RoadmapHomePorts): void;
