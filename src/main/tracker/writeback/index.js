import { getSharedTrackerProviderRegistry } from '../provider-registry';
import { getSharedTrackerWriteBackConfigStore, TrackerWriteBackConfigStore } from './config-store';
import { TrackerWriteBackEngine } from './engine';
import { getSharedTrackerWriteBackLedger, TrackerWriteBackLedger } from './ledger';
import { createProxyItemLookup } from './proxy-item-lookup';
import { createTrackerWriteBackPoster, createWriteBackCapabilityResolver } from './poster';
import { createRunStateReader } from './run-state-reader';
export { TrackerWriteBackConfigStore } from './config-store';
export { TrackerWriteBackLedger } from './ledger';
export { TrackerWriteBackEngine } from './engine';
// Composition root for the write-back engine (MC-1640 / T10). Wires the pure
// engine to its real adapters — the run-store honesty reader, the backlog proxy
// lookup, the registry-backed poster/capabilities, and the persisted config +
// ledger — and returns a debounced `notifyRunActivity` the app bootstrap calls on
// every run lifecycle op. There is NO push channel for run events in the main
// process, so write-back RECONCILES: each op wakes the engine, which reads fresh
// state and posts whatever is newly due. Reconcile is idempotent and
// failure-isolated, so waking it often is safe and cheap (it early-outs when no
// connection has write-back on).
// Coalesce a storm of run ops into one reconcile per run: the runtime broadcasts
// many ops per second while agents work, but the tracker state that matters
// changes rarely, so a short trailing debounce keeps posting responsive without
// hammering the tracker or the backlog scan.
const RECONCILE_DEBOUNCE_MS = 1500;
export function createTrackerWriteBackRuntime(options) {
    const registry = options.registry ?? getSharedTrackerProviderRegistry();
    // Share the process-wide config store in production so the T11 settings IPC and
    // this engine read/write one cache; only an injected userData dir (tests) forks
    // an isolated instance.
    const configStore = options.resolveUserDataDir
        ? new TrackerWriteBackConfigStore({ resolveUserDataDir: options.resolveUserDataDir })
        : getSharedTrackerWriteBackConfigStore();
    // Share the process-wide ledger in production so the connection-removal cleanup
    // in TrackerService and this engine read/write one cache; an injected userData
    // dir (tests) forks an isolated instance.
    const ledger = options.resolveUserDataDir
        ? new TrackerWriteBackLedger({ resolveUserDataDir: options.resolveUserDataDir })
        : getSharedTrackerWriteBackLedger();
    const engine = new TrackerWriteBackEngine({
        runState: createRunStateReader({ readProjection: options.readProjection }),
        proxyItems: createProxyItemLookup(),
        config: configStore,
        capabilities: createWriteBackCapabilityResolver(registry),
        poster: createTrackerWriteBackPoster(registry),
        ledger,
        now: options.now ?? (() => new Date()),
        ...(options.logDiagnostic ? { logDiagnostic: options.logDiagnostic } : {}),
    });
    const scheduler = createReconcileScheduler(engine, options.logDiagnostic);
    const retryConnectionNotices = async (connectionId) => {
        for (const statePath of await ledger.failedStatePaths(connectionId)) {
            const workspaceRoot = workspaceRootFromStatePath(statePath);
            if (!workspaceRoot)
                continue;
            await engine.reconcileRun({ statePath, workspaceRoot });
        }
        return (await ledger.listNotices()).filter((notice) => notice.connectionId === connectionId);
    };
    return { engine, configStore, ledger, notifyRunActivity: scheduler.notify, retryConnectionNotices };
}
// Per-run trailing debounce with re-run coalescing: a notify during an in-flight
// reconcile schedules exactly one more pass (so the latest state is always
// reconciled), and notifies during the debounce window collapse into the pending
// timer. Timers are unref'd so write-back never keeps the process alive.
function createReconcileScheduler(engine, logDiagnostic) {
    const loops = new Map();
    const run = async (statePath, workspaceRoot, loop) => {
        loop.running = true;
        try {
            do {
                loop.rerun = false;
                await engine.reconcileRun({ statePath, workspaceRoot });
            } while (loop.rerun);
        }
        catch (err) {
            // reconcileRun already isolates its own failures; this guards the scheduler.
            logDiagnostic?.('tracker_writeback_scheduler_error', { statePath, message: errorMessage(err) });
        }
        finally {
            loop.running = false;
        }
    };
    return {
        notify(statePath) {
            const workspaceRoot = workspaceRootFromStatePath(statePath);
            if (!workspaceRoot)
                return;
            let loop = loops.get(statePath);
            if (!loop) {
                loop = { timer: null, running: false, rerun: false };
                loops.set(statePath, loop);
            }
            if (loop.running) {
                loop.rerun = true;
                return;
            }
            if (loop.timer)
                return;
            loop.timer = setTimeout(() => {
                loop.timer = null;
                void run(statePath, workspaceRoot, loop);
            }, RECONCILE_DEBOUNCE_MS);
            if (typeof loop.timer.unref === 'function')
                loop.timer.unref();
        },
    };
}
// Derive the workspace root from a run's state path. The run store always lives
// at `<workspaceRoot>/.multi-code/sprintengine/<team>/run.yaml`, so the workspace
// root is everything before the `.multi-code` segment.
export function workspaceRootFromStatePath(statePath) {
    const normalized = statePath.replace(/\\/g, '/');
    const marker = '/.multi-code/sprintengine/';
    const index = normalized.indexOf(marker);
    if (index <= 0)
        return null;
    return normalized.slice(0, index);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : 'Unexpected write-back scheduler error.';
}
