import { type WorkspaceRegistryFile } from '../shared/workspace-registry';
export declare const WORKSPACE_REGISTRY_FILE_NAME = "workspace-registry.json";
export type WorkspaceRegistryStoreDiagnostic = {
    level: 'warning';
    title: string;
    message: string;
    details?: string;
};
export type WorkspaceRegistryStoreDeps = {
    resolveUserDataDir: () => string;
    logDiagnostic?: (diagnostic: WorkspaceRegistryStoreDiagnostic) => void;
    persistDebounceMs?: number;
};
export type WorkspaceRegistryReadOutcome = {
    status: 'loaded';
    file: WorkspaceRegistryFile;
    droppedRecords: {
        id: string;
        reason: string;
    }[];
} | {
    status: 'missing';
} | {
    status: 'unreadable';
    details: string;
};
export type WorkspaceRegistryStore = ReturnType<typeof createWorkspaceRegistryStore>;
export declare function createWorkspaceRegistryStore(deps: WorkspaceRegistryStoreDeps): {
    read: () => WorkspaceRegistryReadOutcome;
    write: (file: WorkspaceRegistryFile) => void;
    flush: () => Promise<void>;
    filePath: () => string;
};
/**
 * An in-memory store with the same contract, for tests that exercise the bus or
 * the authority without touching a real userData directory. `write` is
 * synchronous here on purpose: a test asserting a mutation landed should not
 * have to await a debounce it does not care about.
 */
export declare function createInMemoryWorkspaceRegistryStore(initial?: WorkspaceRegistryFile): WorkspaceRegistryStore & {
    current(): WorkspaceRegistryFile | null;
};
