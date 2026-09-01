export type ModuleStorageErrorCode = 'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error';
export type ModuleStorageResult<T> = ({
    ok: true;
} & T) | {
    ok: false;
    code: ModuleStorageErrorCode;
    message: string;
};
export type ModuleStorageScope = {
    /**
     * Absolute workspace folder for workspace-scoped keys; omit for the
     * module's global (per-user) store.
     */
    workspaceRoot?: string;
};
export type ModuleStorageRegistry = {
    get(moduleId: string, input: ModuleStorageScope & {
        key: string;
    }): Promise<ModuleStorageResult<{
        value: unknown;
        found: boolean;
    }>>;
    set(moduleId: string, input: ModuleStorageScope & {
        key: string;
        value: unknown;
    }): Promise<ModuleStorageResult<object>>;
    delete(moduleId: string, input: ModuleStorageScope & {
        key: string;
    }): Promise<ModuleStorageResult<{
        deleted: boolean;
    }>>;
    list(moduleId: string, input?: ModuleStorageScope): Promise<ModuleStorageResult<{
        keys: string[];
    }>>;
};
export declare const MODULE_STORAGE_VALUE_LIMIT_BYTES: number;
export declare function createModuleStorageRegistry(options: {
    userDataDir: () => string;
}): ModuleStorageRegistry;
