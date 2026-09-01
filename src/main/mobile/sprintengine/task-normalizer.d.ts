export type SprintEngineTaskRecord = {
    id: string;
    role?: string;
    status: 'todo' | 'in_progress' | 'review' | 'needs_input' | 'done' | 'canceled';
    ownerAgentId: string | null;
    dependsOn: string[];
};
export type TaskStatusSources = {
    status: unknown;
    boardColumn: unknown;
};
export declare function selectTaskStatusSources(record: Record<string, unknown>): TaskStatusSources;
export declare function normalizeSprintEngineTasks(value: unknown): SprintEngineTaskRecord[];
