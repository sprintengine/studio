import { workspaceRegistryFolderKey, type PersistedStateClassification, type WorkspaceRegistryActor, type WorkspaceRegistryRecord, type WorkspaceRegistryTombstone } from '../shared/workspace-registry';
import { type WorkspaceSyncCommand, type WorkspaceSyncEvent, type WorkspaceSyncState } from '../shared/workspace-sync';
import type { Workspace, WorkspaceId, WorkspaceMode, WorkspaceWindowId } from '../renderer/src/types/workspace';
import type { WorkspaceRegistryStore } from './workspace-registry-store';
export type WorkspaceRegistryDiagnostic = {
    level: 'warning';
    title: string;
    message: string;
    details?: string;
};
export type WorkspaceRegistryServiceOptions = {
    store: WorkspaceRegistryStore;
    now?: () => number;
    newWorkspaceId?: () => string;
    logDiagnostic?: (diagnostic: WorkspaceRegistryDiagnostic) => void;
};
export type WorkspaceCreateRequest = {
    name?: string;
    folderPath?: string | null;
    templateId?: string;
    mode?: WorkspaceMode;
    /** Target window; defaults to the primary window, which always exists. */
    windowId?: WorkspaceWindowId;
};
export type WorkspaceCreateResult = {
    workspace: WorkspaceRegistryRecord;
    windowId: WorkspaceWindowId;
    folderPath: string | null;
    /** True when an existing one-per-project host/switchboard was reused. */
    reused: boolean;
};
export type WorkspaceRegistryHydrateResult = {
    changed: boolean;
    reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent';
    classification: PersistedStateClassification;
    seededWorkspaceCount: number;
    droppedRecordIds: string[];
};
export type WorkspaceRegistryPrecheck = {
    ok: true;
} | {
    ok: false;
    reason: string;
    message: string;
};
export type WorkspaceRegistryService = ReturnType<typeof createWorkspaceRegistryService>;
/**
 * The renderer's post-migrate-ladder localStorage payload, offered once on the
 * first boot after this landed. Main must never be handed a pre-ladder shape —
 * the ladder lives in the renderer and would not be re-run against main's file.
 */
export type WorkspaceRegistryHydratePayload = {
    workspaces?: unknown;
    activeWorkspaceId?: unknown;
    workspaceWindows?: unknown;
    primaryWorkspaceWindowId?: unknown;
    workspaceRegistryEmptyState?: unknown;
    /** The raw localStorage string, so main classifies with the same guard the renderer uses. */
    rawLocalStorage?: string | null;
};
export declare function createWorkspaceRegistryService(options: WorkspaceRegistryServiceOptions): {
    getState: () => WorkspaceSyncState;
    getRecords: () => WorkspaceRegistryRecord[];
    getRecord: (workspaceId: WorkspaceId) => WorkspaceRegistryRecord | null;
    getRevision: () => number;
    /**
     * Mint an id for a record a caller composes itself and then hands to
     * `adoptRecord` (a sprint run's roster workspace, MC-2160). One generator
     * for both creation shapes, so a composed record's id is indistinguishable
     * from a `prepareCreate` one.
     */
    newWorkspaceId: () => string;
    getTombstones: () => WorkspaceRegistryTombstone[];
    applyEvent: (event: WorkspaceSyncEvent, actor: WorkspaceRegistryActor) => boolean;
    precheckCommand: (command: WorkspaceSyncCommand) => WorkspaceRegistryPrecheck;
    prepareCreate: (input: WorkspaceCreateRequest) => WorkspaceCreateResult;
    adoptRecord: (workspace: Workspace) => WorkspaceRegistryRecord;
    hydrate: (payload: WorkspaceRegistryHydratePayload) => WorkspaceRegistryHydrateResult;
    needsHydration: () => boolean;
    subscribe: (listener: (state: WorkspaceSyncState) => void) => () => void;
    flush: () => Promise<void>;
};
export { workspaceRegistryFolderKey };
