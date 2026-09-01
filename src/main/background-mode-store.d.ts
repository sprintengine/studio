export type BackgroundModeStoreDeps = {
    resolveUserDataDir: () => string;
    logDiagnostic?: (input: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
};
export type BackgroundModeStore = ReturnType<typeof createBackgroundModeStore>;
export declare function createBackgroundModeStore(deps: BackgroundModeStoreDeps): {
    /** The setting the last-window-close decision reads. Never throws. */
    isEnabled(): boolean;
    /** Adopt a renderer push. Idempotent: an unchanged value never rewrites the file. */
    set(enabled: boolean): void;
};
