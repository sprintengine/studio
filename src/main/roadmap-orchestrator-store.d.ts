import type { RoadmapLaneRuntime } from '../shared/sprintengine/roadmap-orchestrator';
export type RoadmapRuntimeRecord = {
    schemaVersion: number;
    roadmapRef: string;
    lanes: RoadmapLaneRuntime[];
};
export declare function roadmapRuntimePath(baseDir: string, roadmapRef: string): {
    path: string;
    queueKey: string;
};
export declare function createRoadmapOrchestratorStore(baseDir: string): {
    read: (roadmapRef: string, legacyRoots?: ReadonlyArray<string>) => Promise<Map<string, RoadmapLaneRuntime>>;
    write: (roadmapRef: string, lanes: ReadonlyMap<string, RoadmapLaneRuntime>) => Promise<void>;
};
