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
export function createSprintPowerManager(deps) {
    const activeRuns = new Set();
    let blockerId = null;
    function reconcile() {
        const shouldHold = activeRuns.size > 0;
        const holding = blockerId !== null && deps.powerSaveBlocker.isStarted(blockerId);
        if (shouldHold && !holding) {
            blockerId = deps.powerSaveBlocker.start('prevent-app-suspension');
            deps.logDiagnostic?.({
                level: 'info',
                title: 'Sleep blocked for active sprint',
                message: `Holding prevent-app-suspension while ${activeRuns.size} sprint run(s) auto-run.`,
            });
            return;
        }
        if (!shouldHold && blockerId !== null) {
            if (deps.powerSaveBlocker.isStarted(blockerId))
                deps.powerSaveBlocker.stop(blockerId);
            blockerId = null;
            deps.logDiagnostic?.({
                level: 'info',
                title: 'Sleep unblocked',
                message: 'All sprint runs are idle; the power-save blocker was released.',
            });
        }
    }
    return {
        /** Mark a run (by statePath) as actively auto-running. Idempotent. */
        markRunActive(statePath) {
            if (!statePath)
                return;
            activeRuns.add(statePath);
            reconcile();
        },
        /** Mark a run as no longer auto-running. Idempotent. */
        markRunInactive(statePath) {
            activeRuns.delete(statePath);
            reconcile();
        },
        /** True while the app-suspension blocker is held. */
        isHolding() {
            return blockerId !== null && deps.powerSaveBlocker.isStarted(blockerId);
        },
        activeRunCount() {
            return activeRuns.size;
        },
        /** App shutdown: release unconditionally so quitting never leaks a blocker. */
        shutdown() {
            activeRuns.clear();
            reconcile();
        },
    };
}
