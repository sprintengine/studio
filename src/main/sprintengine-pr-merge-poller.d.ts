/**
 * Main-owned pull-request merge poller (MC-2155) — a run's merge state self-heals
 * with no window open.
 *
 * A sprint's pull request merges on GitHub, outside the app, long after the run
 * itself finished. Until this ran, the only thing that noticed was a RENDERER
 * supervisor (`SprintEnginePullRequestPollSupervisor.tsx`), so with no window the
 * run's `vcs.pullRequestState` — and everything read off it: the sidebar glyph,
 * the Sprints door rollup, the mobile snapshot, `run-landed` automation chaining —
 * stayed frozen at whatever the last window saw. That contradicts the
 * one-authoritative-store principle: a fact every non-window client reads must not
 * depend on a window being open. This is the single owner of BACKGROUND merge
 * polling now, and the renderer supervisor is retired, so opening a second window
 * no longer doubles the `gh` probes. The decision-scoped probes elsewhere are
 * unaffected and are not pollers: one shot when a run surface opens
 * (`useRunPullRequestMergePoll`, `roadmapBoardData.ts`), and one when a caller
 * must not decide on stale merge state (`roadmap-orchestrator-ports.ts`, and the
 * `run-landed` automation trigger, which carries its own throttle).
 *
 * WHICH RUNS. Not the scheduler's registry — a PR is normally opened as the run
 * finishes, and boot discovery deliberately skips terminal runs, so the runs whose
 * merge state goes stale are precisely the ones the scheduler is not tracking. The
 * target set is the run INDEX's disk scan (`sprintengine-run-index.ts`) filtered by
 * `isRunPullRequestWatchable`: any run, live or historical, with at least one
 * project whose PR is non-terminal. Scanning through `listSprintRuns` also arms
 * that module's per-run projection watches, which is what gives main a live
 * `noteRunChanged` signal headlessly. Those watches are synced to whatever root
 * set last enumerated them, so an open Sprints door listing a NARROWER set can
 * close the watch on a run outside it. That costs arm/disarm freshness for such a
 * run — never a probe already scheduled — and runtime ops keep reporting through
 * the same funnel regardless.
 *
 * WHAT CHANGED FROM THE RENDERER SUPERVISOR, and why:
 * - The schedule no longer HALTS at the cap. The renderer stopped after six probes
 *   (`stopAtMax`) because it had a re-arm trigger — the user re-opening the
 *   workspace — and did not want unbounded `gh` from a window. A headless owner has
 *   no such trigger, and a poller that goes silent 63 minutes after the run
 *   finished does not "self-heal without a window" at all. So the delay grows
 *   1 → 2 → 4 → 8 → 16 → 32 min and then HOLDS at 32 min until that run's last PR
 *   reaches a terminal state, at which point its timer is torn down. When no run
 *   has a watchable PR the poller holds zero timers — the acceptance's
 *   no-steady-state-polling rule is about the app at rest, not about a run whose
 *   PR is genuinely still open.
 * - Jitter is new. The renderer watched a window's handful of workspaces; main
 *   watches every run under every known project root, and arming them all in one
 *   scan would fire their probes in lockstep — a burst of `gh` subprocesses on the
 *   same tick. Each delay is spread by ±{@link PR_MERGE_POLL_JITTER_RATIO}.
 * - The boot scan skips runs untouched for {@link PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS}.
 *   An abandoned run with a PR nobody ever merged or closed would otherwise buy a
 *   `gh` subprocess every 32 minutes forever, for as long as the app runs. The bound
 *   applies ONLY to the scan: any change to such a run arrives through
 *   `noteRunChanged` and puts it straight back under watch.
 */
import { type ExponentialBackoffOptions } from '../shared/exponentialBackoff';
import type { SprintRunSummary } from '../shared/sprintengine/runSummary';
import type { SprintEngineVcs } from '../shared/sprintengine/run-types';
/**
 * 1 → 2 → 4 → 8 → 16 → 32 min, then every 32 min. No `stopAtMax`: see the header
 * for why the headless owner keeps probing where the renderer supervisor halted.
 */
export declare const PR_MERGE_POLL_BACKOFF: ExponentialBackoffOptions;
/** Each delay is multiplied by 1 ± this, so simultaneously-armed runs desynchronize. */
export declare const PR_MERGE_POLL_JITTER_RATIO = 0.2;
/** How stale a run may be and still be picked up by the startup scan (30 days). */
export declare const PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS: number;
/**
 * At most one re-read per run per this window. `notifySprintRunsChanged` fires on
 * EVERY runtime op — several times a minute for a live run — and it drops that
 * run's summary memo first, so an uncoalesced evaluation would re-read, parse and
 * normalize the projection each time just to ask a question whose answer changes
 * about once per run. Well under the base delay, so a newly-opened pull request
 * still arms long before its first probe would have fired.
 */
export declare const PR_MERGE_POLL_CHANGE_COALESCE_MS = 30000;
export type SprintPullRequestMergePollerDeps = {
    /**
     * Every run under the given project roots. Production wires the run index's
     * `listSprintRuns`, whose enumeration also opens the per-run projection watches
     * that feed {@link SprintPullRequestMergePoller.noteRunChanged}.
     */
    listRuns(roots: readonly string[]): Promise<readonly SprintRunSummary[]>;
    /** The run's normalized `vcs` block, or null when it has none / cannot be read. */
    readRunVcs(statePath: string): Promise<SprintEngineVcs | null>;
    /** One `vcs pr-status` probe: refreshes EVERY declared repo of that run in one call. */
    probe(statePath: string): Promise<{
        ok: boolean;
    }>;
    backoff?: ExponentialBackoffOptions;
    jitterRatio?: number;
    bootScanMaxAgeMs?: number;
    changeCoalesceMs?: number;
    timers?: {
        setTimeout(handler: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
    };
    now?(): number;
    /** Injected so jitter is deterministic under test. */
    random?(): number;
    logDiagnostic?(input: {
        level: 'info' | 'warning';
        title: string;
        message: string;
        details?: string;
    }): void;
};
/** What the startup scan decided, so the caller can log it and tests can assert it. */
export type SprintPullRequestMergePollReport = {
    roots: string[];
    /** Runs found under those roots. */
    discovered: number;
    /** State paths now under watch, in discovery order. */
    watching: string[];
    /** Watchable runs the freshness bound left alone. */
    skippedStale: string[];
};
export type SprintPullRequestMergePoller = {
    /**
     * Scan and arm. Called once, at app ready, by the Sprint Engine capability
     * module — so a disabled module never starts a probe, and `noteRunChanged` is
     * inert until it has run.
     */
    start(input: {
        listWorkspaceRoots(): readonly string[];
    }): Promise<SprintPullRequestMergePollReport>;
    /**
     * A run's state changed on disk (main's `notifySprintRunsChanged` funnel: every
     * runtime op, every engine projection write a watch caught, every non-resident
     * mutation). Re-reads just that run and arms or disarms it. Deliberately does
     * NOT restart an already-armed run's schedule — our own probe rewrites the
     * projection, so re-arming on change would loop a watched run at the base delay
     * forever.
     */
    noteRunChanged(statePath: string): void;
    /** State paths holding a live timer. Introspection for diagnostics and tests. */
    watchedStatePaths(): string[];
    dispose(): void;
};
export declare function createSprintPullRequestMergePoller(deps: SprintPullRequestMergePollerDeps): SprintPullRequestMergePoller;
/**
 * Whether the startup scan leaves this run alone. Freshness is the run's own
 * `updatedAt` (the projection's, falling back to its file mtime). A run reporting
 * no timestamp at all is NOT treated as stale: the budget bound must never be the
 * reason a run with a genuinely open PR goes unwatched.
 */
export declare function isStaleForBootScan(run: Pick<SprintRunSummary, 'updatedAt'>, nowMs: number, maxAgeMs: number): boolean;
