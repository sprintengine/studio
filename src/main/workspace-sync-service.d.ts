import { type WorkspaceFieldsPatch, type WorkspaceSyncCommandResult, type WorkspaceSyncEvent, type WorkspaceSyncSnapshot } from '../shared/workspace-sync';
import type { WorkspaceCreateRequest, WorkspaceCreateResult, WorkspaceRegistryService } from './workspace-registry-service';
import type { WorkspaceRegistryActor } from '../shared/workspace-registry';
import type { AgentState, Workspace, WorkspaceId } from '../renderer/src/types/workspace';
type DispatchInput = {
    command: unknown;
    sourceWindowId: string;
};
type WorkspaceSyncServiceOptions = {
    registry: WorkspaceRegistryService;
    maxReplayEvents?: number;
    now?: () => number;
    resolveResumeCapabilities?: (cli: string) => {
        resumeSession: boolean;
        sessionIdFromCaller: boolean;
    };
};
export type WorkspaceSyncService = ReturnType<typeof createWorkspaceSyncService>;
/** Actor names the process boundary a main-originated mutation came through. */
export type WorkspaceMutationActor = WorkspaceRegistryActor;
export declare function createWorkspaceSyncService(options: WorkspaceSyncServiceOptions): {
    adoptWorkspace: (workspace: Workspace, windowId: string, folderPath: string | null, actor: WorkspaceMutationActor) => WorkspaceSyncCommandResult;
    createWorkspace: (input: WorkspaceCreateRequest, actor: WorkspaceMutationActor) => {
        ok: true;
        result: WorkspaceCreateResult;
    } | {
        ok: false;
        reason: string;
        message: string;
    };
    dispatch: (input: DispatchInput) => WorkspaceSyncCommandResult;
    flush: () => Promise<void>;
    getEventsAfter: (sequence: unknown) => WorkspaceSyncEvent[];
    getSnapshot: () => WorkspaceSyncSnapshot;
    removeWorkspace: (workspaceId: WorkspaceId, actor: WorkspaceMutationActor) => WorkspaceSyncCommandResult;
    subscribeEvents: (listener: (event: WorkspaceSyncEvent) => void) => () => void;
    updateWorkspaceAgent: (workspaceId: WorkspaceId, agentId: string, patch: Partial<AgentState> | null, actor: WorkspaceMutationActor) => WorkspaceSyncCommandResult;
    updateWorkspaceFields: (workspaceId: WorkspaceId, patch: WorkspaceFieldsPatch, actor: WorkspaceMutationActor) => WorkspaceSyncCommandResult;
};
export {};
