import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { discoverSprintEngineRunStatePaths } from './sprintengine-run-index';
// A run whose lifecycle has ended: nothing new will be worked, so it is dead
// weight on the phone beyond a short "recently finished" tail. The run-level
// status the engine writes to run.yaml / projection.json (recompute_phase in
// sprintengine_core/tool/tasks.py). Anything else — including planning/executing
// and an unreadable/unknown status — is treated as live and always kept.
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'archived', 'canceled']);
// How many of the most-recent terminal runs the unscoped snapshot keeps for the
// phone's "recently finished" affordance. Bounded and small: it sits below the
// size-shedding ladder, so a fleet of finished runs cannot crowd out the live ones.
const defaultTerminalRunKeepCount = 3;
// The phone's run discovery is now a consumer of the shared run-index scan (D1):
// same dedupe-by-statePath and newest-first sort, one implementation. The
// empty-roots → cwd fallback is a mobile-only quirk kept here so the snapshot's
// behavior is unchanged; the shared scan itself takes exactly the roots given.
export async function discoverMobileSprintEngineStatePaths(workspaceRoots) {
    const roots = workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()];
    const discovered = await discoverSprintEngineRunStatePaths(roots);
    return discovered.map((item) => item.statePath);
}
// The default (unscoped) snapshot's sprint-engine set: every live run plus the
// most-recent terminal ones. Input order is preserved, so with the discovery's
// updatedAt-descending order the kept terminal runs are the newest few. Scoped
// requests (sprintEngineId / workspacePath) do NOT pass through here — they get
// their exact scope, terminal or not, so the phone can still open a finished run
// it names directly.
export async function filterToDefaultSnapshotStatePaths(statePaths, keepTerminal = defaultTerminalRunKeepCount) {
    const terminalFlags = await Promise.all(statePaths.map(isTerminalRunStatePath));
    const kept = [];
    let terminalKept = 0;
    statePaths.forEach((statePath, index) => {
        if (!terminalFlags[index]) {
            kept.push(statePath);
            return;
        }
        if (terminalKept < keepTerminal) {
            kept.push(statePath);
            terminalKept += 1;
        }
    });
    return kept;
}
async function isTerminalRunStatePath(statePath) {
    let raw;
    try {
        raw = await readFile(join(dirname(statePath), 'projection.json'), 'utf8');
    }
    catch {
        // No projection yet (freshly created) or unreadable: treat as live and keep.
        return false;
    }
    try {
        const projection = JSON.parse(raw);
        const status = projection.run?.status ?? projection.status;
        return typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status);
    }
    catch {
        return false;
    }
}
