/**
 * Power management for active sprint auto-runs (sprint-runtime-ownership
 * Phase 2). While at least one sprint is actively auto-running, hold a
 * `powerSaveBlocker('prevent-app-suspension')` so the machine doesn't sleep
 * out from under the run; release it the moment the last run goes idle /
 * complete / manual, and unconditionally on app shutdown.
 *
 * The blocker deliberately prevents app suspension only — the display may
 * still sleep and lock; the main-process scheduler and the PTYs keep running
 * behind a locked screen.
 *
 * Electron's powerSaveBlocker is injected so the lifecycle is unit-testable;
 * the id-based API is wrapped into a single refcount keyed by statePath so
 * double-adds and double-releases are harmless.
 */
export type PowerSaveBlockerLike = {
    start(type: 'prevent-app-suspension'): number;
    stop(id: number): void;
    isStarted(id: number): boolean;
};
export type SprintPowerManagerDeps = {
    powerSaveBlocker: PowerSaveBlockerLike;
    logDiagnostic?: (input: {
        level: 'info' | 'warning';
        title: string;
        message: string;
    }) => void;
};
export type SprintPowerManager = ReturnType<typeof createSprintPowerManager>;
export declare function createSprintPowerManager(deps: SprintPowerManagerDeps): {
    /** Mark a run (by statePath) as actively auto-running. Idempotent. */
    markRunActive(statePath: string): void;
    /** Mark a run as no longer auto-running. Idempotent. */
    markRunInactive(statePath: string): void;
    /** True while the app-suspension blocker is held. */
    isHolding(): boolean;
    activeRunCount(): number;
    /** App shutdown: release unconditionally so quitting never leaks a blocker. */
    shutdown(): void;
};
