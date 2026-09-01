import { type ModuleWorkspaceView } from '../../shared/modules/workspace-view';
import type { WorkspaceCreateRequest } from '../workspace-registry-service';
import type { WorkspaceSyncService } from '../workspace-sync-service';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
export type ModuleWorkspaceCreateInput = WorkspaceCreateRequest;
export type ModuleWorkspaceCreateResult = {
    ok: true;
    workspaceId: string;
} | {
    ok: false;
    code: string;
    message: string;
};
export type ModuleWorkspaceService = {
    create(input: ModuleWorkspaceCreateInput): Promise<ModuleWorkspaceCreateResult>;
};
export type ModuleWorkspaceServiceBackends = {
    workspaceSync: Pick<WorkspaceSyncService, 'createWorkspace'>;
};
export declare function createModuleWorkspaceService(backends: ModuleWorkspaceServiceBackends): ModuleWorkspaceService;
export type { ModuleWorkspaceView } from '../../shared/modules/workspace-view';
export type ModuleWorkspaceContextService = {
    get(workspaceId: string): Promise<ModuleWorkspaceView | null>;
};
export type ModuleWorkspaceContextBackends = {
    getWorkspaceSyncSnapshot: () => WorkspaceSyncSnapshot;
};
export declare function createModuleWorkspaceContextService(backends: ModuleWorkspaceContextBackends): ModuleWorkspaceContextService;
