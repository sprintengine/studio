import { type SprintEngineLaunchSettings, type SprintEngineLaunchSettingsRecord } from '../shared/sprintengine/launch-settings';
export type SprintEngineLaunchSettingsMirrorDeps = {
    resolveUserDataDir: () => string;
    logDiagnostic?: (input: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
    now?: () => number;
};
export type SprintEngineLaunchSettingsWriteResult = {
    record: SprintEngineLaunchSettingsRecord;
    /** False for an idempotent no-op: same content, or a hydrate onto an existing record. */
    changed: boolean;
    /** Resolves when the atomic write has settled (or failed soft). */
    persisted: Promise<void>;
};
export type SprintEngineLaunchSettingsMirror = ReturnType<typeof createSprintEngineLaunchSettingsMirror>;
export declare function createSprintEngineLaunchSettingsMirror(deps: SprintEngineLaunchSettingsMirrorDeps): {
    /** The settings main spawns with. Never throws: an absent store reads as defaults. */
    get(): SprintEngineLaunchSettings;
    /** The authoritative record, or null when nothing has been written yet. */
    getRecord(): SprintEngineLaunchSettingsRecord | null;
    /**
     * Adopt a renderer push. A content-identical push is a no-op: no revision
     * bump, no write, no subscriber wake — the renderer pushes on every store
     * change, and an unchanged blob is not a new revision.
     */
    set(raw: unknown): SprintEngineLaunchSettingsWriteResult;
    /**
     * One-time seed from the renderer's persisted settings, for the first boot
     * after this store landed (or a fresh install). No-op once a record
     * exists: main's record is authoritative from then on, and the renderer
     * reconciles against it rather than re-asserting.
     */
    hydrate(raw: unknown): SprintEngineLaunchSettingsWriteResult;
    subscribe(listener: (settings: SprintEngineLaunchSettings) => void): () => void;
};
