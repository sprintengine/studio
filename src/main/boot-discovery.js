import { detectAgentCliAvailability } from './cli-availability';
import { listFolderOpenTargetAvailability, resolveFolderOpenLauncherHere } from './ipc/folder-open-ipc';
// Declaration order is DISPLAY order, not run order: the legs run concurrently,
// and the status line names the first of these that has not resolved yet. The
// CLI leg spawns a login shell per registered CLI and dominates the wall clock,
// so in practice this reads "Finding your agents…" for most of the boot — which
// is the honest thing to say while that is what is happening.
const LEGS = [
    { id: 'cli', status: 'Finding your agents…' },
    { id: 'editors', status: 'Looking for editors…' },
    { id: 'updates', status: 'Checking for updates…' },
];
export async function runBootDiscovery(deps = {}) {
    const onProgress = deps.onProgress ?? (() => { });
    const onLegError = deps.onLegError
        ?? ((leg, error) => {
            console.error(`[BootDiscovery] ${leg} leg failed`, error);
        });
    const runners = {
        cli: deps.detectClis ?? (() => detectAgentCliAvailability()),
        editors: deps.detectEditors
            ?? (async () => listFolderOpenTargetAvailability(resolveFolderOpenLauncherHere)),
        updates: deps.checkUpdates ?? (async () => undefined),
    };
    const unresolved = new Set(LEGS.map((leg) => leg.id));
    const emit = () => {
        const inFlight = LEGS.find((leg) => unresolved.has(leg.id));
        onProgress({
            // Empty once everything has resolved: the plate holds the brand moment for
            // the few frames before the reveal rather than leaving a stale leg name up.
            status: inFlight?.status ?? '',
            progress: (LEGS.length - unresolved.size) / LEGS.length,
        });
    };
    emit();
    await Promise.all(LEGS.map(async (leg) => {
        try {
            await runners[leg.id]();
        }
        catch (error) {
            // A failed leg is reported, never swallowed — but it must not stall the
            // reveal. Nothing downstream consumes these results: the renderer
            // re-runs each probe as its own authoritative source, so a leg that
            // fails here costs a warmed cache, not correctness.
            onLegError(leg.id, error);
        }
        finally {
            unresolved.delete(leg.id);
            emit();
        }
    }));
}
