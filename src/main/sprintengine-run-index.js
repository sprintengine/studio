import { watch } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { pathExists } from './filesystem-workspace';
import { normalizeSprintEngineProjection } from '../shared/sprintengine/state';
import { describeUnsupportedSprintEngineStore } from '../shared/sprintengine/store-schema';
import { deriveSprintRunSummary } from '../shared/sprintengine/runSummary';
// The main-process index answering "what sprint runs exist in this Multicode —
// live AND historical — across every known project root", without a resident
// workspace object per run. Data source for the Sprints door rail (T3) and
// canvas (T4). The disk scan is promoted from mobile discovery (D1): mobile is
// now a consumer of the same `discoverSprintEngineRunStatePaths` below, so there
// is one scan/dedupe/sort implementation and the two surfaces cannot drift.
//
// Never parses store internals: a projection is read only through
// `normalizeSprintEngineProjection` (the renderer/mobile boundary rule), and
// completion / cancellation / landed are the shared predicates, reused via
// `deriveSprintRunSummary`. A missing or unreadable projection yields a visible
// `unknown`-state row with a reason, never a dropped row and never a crash.
// The one name for the run's projection: the file the summaries are derived
// from, the file the memo is keyed on, and the file the watch below fires for.
const PROJECTION_FILE_NAME = 'projection.json';
// Scan one project root for its `<root>/.multi-code/sprintengine/*/run.yaml`
// runs. A root with no sprint tree (or an unreadable one) contributes nothing.
async function discoverSprintEngineStatePaths(workspaceRoot) {
    const sprintEngineRoot = join(workspaceRoot, '.multi-code', 'sprintengine');
    let entries;
    try {
        entries = await readdir(sprintEngineRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const statePaths = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
        const statePath = join(sprintEngineRoot, entry.name, 'run.yaml');
        if (!(await pathExists(statePath))) {
            return null;
        }
        return {
            statePath,
            updatedAtMs: await readSprintEngineUpdatedAtMs(statePath, join(sprintEngineRoot, entry.name, PROJECTION_FILE_NAME)),
        };
    }));
    return statePaths.filter((statePath) => Boolean(statePath));
}
/**
 * Every run under every given project root, deduped by state path (the same run
 * reachable through two roots is kept once, at its newest observed mtime) and
 * sorted newest-first. The shared scan for both the desktop run index and the
 * mobile snapshot discovery. Given exactly the roots to scan — the caller owns
 * any default-root policy.
 */
export async function discoverSprintEngineRunStatePaths(workspaceRoots) {
    const statePathGroups = await Promise.all(workspaceRoots.map((root) => discoverSprintEngineStatePaths(root)));
    const discovered = new Map();
    for (const item of statePathGroups.flat()) {
        const existing = discovered.get(item.statePath);
        if (!existing || item.updatedAtMs > existing.updatedAtMs) {
            discovered.set(item.statePath, item);
        }
    }
    return [...discovered.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.statePath.localeCompare(right.statePath));
}
async function readSprintEngineUpdatedAtMs(statePath, projectionPath) {
    const [projectionStats, stateStats] = await Promise.all([
        stat(projectionPath).catch(() => null),
        stat(statePath).catch(() => null),
    ]);
    return projectionStats?.mtimeMs ?? stateStats?.mtimeMs ?? 0;
}
const summaryCache = new Map();
/** Drop a run's cached summary so the next read re-derives it from disk. */
export function invalidateSprintRunSummary(statePath) {
    summaryCache.delete(statePath);
}
// `<root>/.multi-code/sprintengine/<team>/run.yaml` → its identity fields.
function resolveRunIdentity(statePath) {
    const teamDirectory = dirname(statePath);
    const sprintEngineRoot = dirname(teamDirectory);
    const projectRoot = dirname(dirname(sprintEngineRoot));
    return {
        teamDirectory,
        teamSlug: lastPathSegment(teamDirectory),
        projectRoot,
        projectName: lastPathSegment(projectRoot),
    };
}
// Project display name: last path segment, normalizing separators and a
// trailing slash — the same rule the renderer's rail applies, so main and the
// Sprints door name a project identically.
function lastPathSegment(path) {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/u, '');
    const lastSlash = normalized.lastIndexOf('/');
    return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)) || normalized;
}
/**
 * The compact summary for one run, memoized on the projection's mtime+size. A
 * missing / unreadable / non-JSON / unsupported-schema / malformed projection all
 * resolve to an `unknown`-state row carrying its reason — never a throw, never a
 * dropped row (Fallback Discipline).
 */
export async function readSprintRunSummary(statePath) {
    return (await readSprintRunRecord(statePath)).summary;
}
/**
 * The run's normalized `vcs` block, or null for a run with no worktree branch (or
 * a projection that could not be read — indistinguishable from "nothing to
 * merge" here, and both mean "nothing to probe"). Shares the summary memo above,
 * so asking for both costs one read.
 */
export async function readSprintRunVcs(statePath) {
    return (await readSprintRunRecord(statePath)).vcs;
}
async function readSprintRunRecord(statePath) {
    const identity = resolveRunIdentity(statePath);
    const projectionPath = join(identity.teamDirectory, PROJECTION_FILE_NAME);
    const stats = await stat(projectionPath).catch(() => null);
    const cacheKey = stats ? `${stats.mtimeMs}:${stats.size}` : 'absent';
    const cached = summaryCache.get(statePath);
    if (cached && cached.key === cacheKey)
        return cached;
    const derived = await deriveSummaryFromDisk(statePath, projectionPath, identity, stats?.mtime ?? null);
    const entry = { key: cacheKey, ...derived };
    summaryCache.set(statePath, entry);
    return entry;
}
async function deriveSummaryFromDisk(statePath, projectionPath, identity, projectionMtime) {
    const base = {
        statePath,
        teamSlug: identity.teamSlug,
        projectRoot: identity.projectRoot,
        projectName: identity.projectName,
        updatedAtFallback: projectionMtime ? projectionMtime.toISOString() : null,
    };
    // Every unreadable-projection exit carries no vcs: "could not be read" and
    // "nothing to merge" are the same answer for the merge poller, which must not
    // probe a run it cannot inspect.
    const unreadable = (unknownReason, unknownKind) => ({
        summary: deriveSprintRunSummary({
            ...base,
            state: null,
            unknownReason,
            ...(unknownKind ? { unknownKind } : {}),
        }),
        vcs: null,
    });
    let raw;
    try {
        raw = await readFile(projectionPath, 'utf8');
    }
    catch {
        return unreadable('Run projection has not been written yet.');
    }
    let projection;
    try {
        projection = JSON.parse(raw);
    }
    catch {
        return unreadable('Run projection is not valid JSON.');
    }
    const rejection = describeUnsupportedSprintEngineStore(projection, identity.teamDirectory);
    if (rejection) {
        // Permanent, not "could not be read just now": the store predates this build
        // and is never migrated, so the surfaces render the remedy, not a retry.
        return unreadable(rejection, 'unsupported_store');
    }
    const state = normalizeSprintEngineProjection(projection, identity.teamSlug);
    if (!state) {
        return unreadable('Run projection is malformed.');
    }
    return { summary: deriveSprintRunSummary({ ...base, state }), vcs: state.vcs ?? null };
}
/**
 * Every run across the given project roots as a compact summary, newest-first.
 * The Sprints door's data source. Summaries are memoized per statePath; entries
 * for runs no longer discovered (team dir deleted) are pruned so the cache stays
 * bounded to existing runs.
 */
export async function listSprintRuns(workspaceRoots) {
    const uniqueRoots = [...new Set(workspaceRoots)];
    const discovered = await discoverSprintEngineRunStatePaths(uniqueRoots);
    const summaries = await Promise.all(discovered.map((item) => readSprintRunSummary(item.statePath)));
    const live = new Set(discovered.map((item) => item.statePath));
    for (const statePath of summaryCache.keys()) {
        if (!live.has(statePath))
            summaryCache.delete(statePath);
    }
    syncProjectionWatches(live);
    return summaries;
}
// --- Projection-write watch --------------------------------------------------
// Projections are written by the Python engine, so main has no write path to
// emit from: a run advancing purely on disk (manual mode, agents publishing over
// MCP) moves no scheduler op, and the Sprints rail would hold a stale row until
// one happened to fire. Each discovered run gets a watch on its own run
// directory instead (MC-1801).
//
// Non-recursive is load-bearing, not incidental: `projection.json` is a direct
// child of the run directory, and `fs.watch({ recursive: true })` is only
// enabled for win32/darwin in this codebase (`src/main/ipc/filesystem-watch-search-ipc.ts`),
// so a per-run watch is the shape that works on every platform. Bursts coalesce
// on the same window as that file's renderer watchers (see the note on
// `scheduleProjectionNotify` for the one deliberate difference).
//
// The signal is deliberately lossy-in-one-direction: macOS replays writes that
// landed just before a watcher armed, so opening the door can cost one extra
// refetch. A refetch is idempotent and memoized, while a missed write is a rail
// that lies — so an extra notification is always the safer error.
const PROJECTION_WRITE_COALESCE_MS = 100;
const projectionWatches = new Map();
let projectionWriteSink = null;
/**
 * Route projection writes to `sink` — main's `notifySprintRunsChanged`, which
 * drops the run's memo and pushes the runs-changed event. Watches themselves are
 * opened and closed by `listSprintRuns`'s enumeration, so a run whose directory
 * disappears closes its watch on the next list. Passing `null` stops watching
 * and closes every open watcher.
 */
export function watchSprintRunProjections(sink) {
    projectionWriteSink = sink;
    if (sink)
        return;
    for (const statePath of [...projectionWatches.keys()])
        closeProjectionWatch(statePath);
}
/** The run directories currently watched for projection writes. */
export function watchedSprintRunProjectionPaths() {
    return [...projectionWatches.keys()];
}
function syncProjectionWatches(discovered) {
    if (!projectionWriteSink)
        return;
    for (const statePath of [...projectionWatches.keys()]) {
        if (!discovered.has(statePath))
            closeProjectionWatch(statePath);
    }
    for (const statePath of discovered) {
        if (!projectionWatches.has(statePath))
            openProjectionWatch(statePath);
    }
}
function openProjectionWatch(statePath) {
    let watcher;
    try {
        watcher = watch(dirname(statePath), { recursive: false }, (_eventType, filename) => {
            // A platform that reports no filename cannot say which child changed;
            // notifying is the honest read, since a missed projection write is a rail
            // that lies while a spurious one costs one refetch.
            const changed = typeof filename === 'string' ? basename(filename) : null;
            if (changed && changed !== PROJECTION_FILE_NAME)
                return;
            scheduleProjectionNotify(statePath);
        });
    }
    catch {
        // The run directory vanished between the scan and here, or the platform
        // refused the watch: this run has no live signal until the next enumeration
        // retries. Never fatal to listing runs.
        return;
    }
    // A deleted or unreadable directory surfaces as an error event; drop the watch
    // rather than keep a dead handle. Enumeration reopens it if the run returns.
    watcher.on('error', () => closeProjectionWatch(statePath));
    projectionWatches.set(statePath, { watcher, flushTimer: null });
}
// One notification per coalescing window, timed from the burst's first event.
// Deliberately not the renderer watchers' restart-the-timer-per-event debounce
// (`filesystem-watch-search-ipc.ts`): an engine writing faster than the window
// would keep restarting it and the door would never hear about a run that is
// very much moving. A fixed window bounds the events without starving.
function scheduleProjectionNotify(statePath) {
    const entry = projectionWatches.get(statePath);
    if (!entry || entry.flushTimer)
        return;
    entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        projectionWriteSink?.(statePath);
    }, PROJECTION_WRITE_COALESCE_MS);
}
function closeProjectionWatch(statePath) {
    const entry = projectionWatches.get(statePath);
    if (!entry)
        return;
    if (entry.flushTimer)
        clearTimeout(entry.flushTimer);
    entry.watcher.close();
    projectionWatches.delete(statePath);
}
