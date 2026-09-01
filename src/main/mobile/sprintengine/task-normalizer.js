export function selectTaskStatusSources(record) {
    return {
        status: record.stateStatus ?? record.status,
        boardColumn: record.boardColumn,
    };
}
export function normalizeSprintEngineTasks(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((task) => {
        if (!task || typeof task !== 'object' || Array.isArray(task))
            return [];
        const record = task;
        if (typeof record.id !== 'string' || !record.id.trim())
            return [];
        const role = typeof record.role === 'string' && record.role.trim() ? record.role : undefined;
        // Command readiness only needs the semantic status, not the board lane
        // (folder-store records mirror the board column into `status`).
        return [{
                id: record.id,
                ...(role ? { role } : {}),
                status: normalizeTaskStatus(selectTaskStatusSources(record).status),
                ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
                    ? record.ownerAgentId
                    : null,
                dependsOn: Array.isArray(record.dependsOn)
                    ? record.dependsOn.filter((dependency) => typeof dependency === 'string')
                    : [],
            }];
    });
}
function normalizeTaskStatus(value) {
    if (value === 'in_progress' || value === 'review' || value === 'needs_input' || value === 'done' || value === 'canceled')
        return value;
    return 'todo';
}
