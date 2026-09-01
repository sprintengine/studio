import { type ModuleRegistrySnapshot, type ModuleRegistrySnapshotWriteResult } from '../../shared/modules/registry-snapshot';
export type ModuleRegistryMirror = {
    /** The last accepted snapshot, or null before the renderer has pushed one. */
    read(): ModuleRegistrySnapshot | null;
    /** Accept a push. A malformed payload is refused; the cached snapshot stands. */
    write(value: unknown): ModuleRegistrySnapshotWriteResult;
};
export declare function createModuleRegistryMirror(): ModuleRegistryMirror;
