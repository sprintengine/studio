import type { ValidSprintEngineStatePath } from './state-path';
import { type SprintEngineTaskRecord } from './task-normalizer';
export type SprintEngineArtifactRecord = {
    id: string;
    path?: string;
};
type SprintEngineRuntimeAgentRecord = {
    role?: string;
    status?: string;
};
type RawSprintEngineState = {
    tasks?: unknown[];
    artifacts?: unknown[];
    sprintEngineAgents?: Record<string, SprintEngineRuntimeAgentRecord>;
};
/**
 * Read the normalized Sprint Engine state used by mobile command readiness
 * checks. The folder-store projection (`projection.json`) is the source of
 * truth. The projection's canonical `workers` view (active leases + live
 * sessions, MC-1591) is read as `sprintEngineAgents` so downstream readers see
 * one shape; the pre-lease `projection.roster` bridge is no longer consulted.
 */
export declare function readRawSprintEngineState(state: ValidSprintEngineStatePath): Promise<RawSprintEngineState>;
export declare function findSprintEngineArtifact(state: ValidSprintEngineStatePath, artifactId: string): Promise<SprintEngineArtifactRecord>;
export declare function findReadySprintEngineTask(state: ValidSprintEngineStatePath, taskId: string, role: string): Promise<SprintEngineTaskRecord & {
    role: string;
}>;
export declare function assertKnownActiveSprintEngineAgent(state: ValidSprintEngineStatePath, agentId: string): Promise<void>;
export {};
