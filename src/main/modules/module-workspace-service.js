import { toModuleWorkspaceView } from '../../shared/modules/workspace-view';
export function createModuleWorkspaceService(backends) {
    return {
        async create(input) {
            const outcome = backends.workspaceSync.createWorkspace(input, 'module');
            if (!outcome.ok)
                return { ok: false, code: outcome.reason, message: outcome.message };
            return { ok: true, workspaceId: outcome.result.workspace.id };
        },
    };
}
export function createModuleWorkspaceContextService(backends) {
    return {
        async get(workspaceId) {
            const workspace = backends
                .getWorkspaceSyncSnapshot()
                .state.workspaces.find((entry) => entry.id === workspaceId);
            if (!workspace)
                return null;
            return toModuleWorkspaceView(workspace);
        },
    };
}
