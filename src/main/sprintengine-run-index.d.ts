import { type SprintRunSummary } from '../shared/sprintengine/runSummary';
import type { SprintEngineVcs } from '../shared/sprintengine/run-types';
export type DiscoveredSprintEngineStatePath = {
    statePath: string;
    updatedAtMs: number;
};
/**
 * Every run under every given project root, deduped by state path (the same run
 * reachable through two roots is kept once, at its newest observed mtime) and
 * sorted newest-first. The shared scan for both the desktop run index and the
 * mobile snapshot discovery. Given exactly the roots to scan — the caller owns
 * any default-root policy.
 */
export declare function discoverSprintEngineRunStatePaths(workspaceRoots: string[]): Promise<DiscoveredSprintEngineStatePath[]>;
/** Drop a run's cached summary so the next read re-derives it from disk. */
export declare function invalidateSprintRunSummary(statePath: string): void;
/**
 * The compact summary for one run, memoized on the projection's mtime+size. A
 * missing / unreadable / non-JSON / unsupported-schema / malformed projection all
 * resolve to an `unknown`-state row carrying its reason — never a throw, never a
 * dropped row (Fallback Discipline).
 */
export declare function readSprintRunSummary(statePath: string): Promise<SprintRunSummary>;
/**
 * The run's normalized `vcs` block, or null for a run with no worktree branch (or
 * a projection that could not be read — indistinguishable from "nothing to
 * merge" here, and both mean "nothing to probe"). Shares the summary memo above,
 * so asking for both costs one read.
 */
export declare function readSprintRunVcs(statePath: string): Promise<SprintEngineVcs | null>;
/**
 * Every run across the given project roots as a compact summary, newest-first.
 * The Sprints door's data source. Summaries are memoized per statePath; entries
 * for runs no longer discovered (team dir deleted) are pruned so the cache stays
 * bounded to existing runs.
 */
export declare function listSprintRuns(workspaceRoots: string[]): Promise<SprintRunSummary[]>;
/**
 * Route projection writes to `sink` — main's `notifySprintRunsChanged`, which
 * drops the run's memo and pushes the runs-changed event. Watches themselves are
 * opened and closed by `listSprintRuns`'s enumeration, so a run whose directory
 * disappears closes its watch on the next list. Passing `null` stops watching
 * and closes every open watcher.
 */
export declare function watchSprintRunProjections(sink: ((statePath: string) => void) | null): void;
/** The run directories currently watched for projection writes. */
export declare function watchedSprintRunProjectionPaths(): string[];
