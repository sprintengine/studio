import type { SprintCreateRequest, SprintCreateResult } from '../shared/sprint-create';
import type { RoadmapOrchestratorPorts } from './roadmap-orchestrator';
import type { SprintEngineAutomationFrontDoors } from './automations/actions/sprint-engine';
export type RoadmapOrchestratorPortsDeps = {
    frontDoors: SprintEngineAutomationFrontDoors;
    createSprint(request: SprintCreateRequest): Promise<SprintCreateResult>;
    getHomeProjectRoot(): string | null;
    getWorkspaceRoots(): string[];
    notify(input: {
        severity: 'info' | 'warning' | 'error';
        title: string;
        body?: string;
    }): void;
};
export declare function createRoadmapOrchestratorPorts(deps: RoadmapOrchestratorPortsDeps): RoadmapOrchestratorPorts;
