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
import { backoffDelayMs } from '../shared/exponentialBackoff';
import { isRunPullRequestWatchable } from '../shared/sprintengine/vcs';
/**
 * 1 → 2 → 4 → 8 → 16 → 32 min, then every 32 min. No `stopAtMax`: see the header
 * for why the headless owner keeps probing where the renderer supervisor halted.
 */
export const PR_MERGE_POLL_BACKOFF = {
    baseMs: 60_000,
    factor: 2,
    maxMs: 32 * 60_000,
};
/** Each delay is multiplied by 1 ± this, so simultaneously-armed runs desynchronize. */
export const PR_MERGE_POLL_JITTER_RATIO = 0.2;
/** How stale a run may be and still be picked up by the startup scan (30 days). */
export const PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * At most one re-read per run per this window. `notifySprintRunsChanged` fires on
 * EVERY runtime op — several times a minute for a live run — and it drops that
 * run's summary memo first, so an uncoalesced evaluation would re-read, parse and
 * normalize the projection each time just to ask a question whose answer changes
 * about once per run. Well under the base delay, so a newly-opened pull request
 * still arms long before its first probe would have fired.
 */
export const PR_MERGE_POLL_CHANGE_COALESCE_MS = 30_000;
export function createSprintPullRequestMergePoller(deps) {
    const backoff = deps.backoff ?? PR_MERGE_POLL_BACKOFF;
    const jitterRatio = deps.jitterRatio ?? PR_MERGE_POLL_JITTER_RATIO;
    const maxAgeMs = deps.bootScanMaxAgeMs ?? PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS;
    const coalesceMs = deps.changeCoalesceMs ?? PR_MERGE_POLL_CHANGE_COALESCE_MS;
    const now = deps.now ?? (() => Date.now());
    const random = deps.random ?? Math.random;
    const timers = deps.timers ?? {
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) => clearTimeout(handle),
    };
    const entries = new Map();
    // Serializes the async re-evaluations of one run, so a burst of change
    // notifications cannot interleave an arm with a disarm for the same path.
    const evaluations = new Map();
    // Change-notification coalescing per run: when it last read, and the trailing
    // timer holding a notification that arrived inside the window.
    const lastEvaluatedAt = new Map();
    const trailingEvaluations = new Map();
    let started = false;
    let disposed = false;
    function jittered(delayMs) {
        if (jitterRatio <= 0)
            return delayMs;
        // random() ∈ [0,1) → a factor in [1 - ratio, 1 + ratio).
        return Math.max(0, Math.round(delayMs * (1 + (random() * 2 - 1) * jitterRatio)));
    }
    function schedule(statePath) {
        const entry = entries.get(statePath);
        if (!entry || disposed)
            return;
        const delay = backoffDelayMs(entry.attempt, backoff);
        // A non-stopping schedule never exhausts; a caller that configured one that
        // does gets the renderer's old halt-and-stay-silent behaviour instead of a
        // crash.
        if (delay === null) {
            entry.handle = null;
            return;
        }
        entry.handle = timers.setTimeout(() => {
            const armed = entries.get(statePath);
            if (!armed || armed !== entry || disposed)
                return;
            armed.handle = null;
            void probeThenReschedule(statePath, armed);
        }, jittered(delay));
    }
    async function probeThenReschedule(statePath, armed) {
        try {
            await deps.probe(statePath);
        }
        catch {
            // Best-effort: a transient gh/git failure just retries on the next step.
            // A run whose PR is genuinely gone stops via the watchability re-read below.
        }
        if (disposed)
            return;
        // Disarm/re-arm during the in-flight probe wins.
        if (entries.get(statePath) !== armed)
            return;
        armed.attempt += 1;
        // The probe just rewrote this run's projection: re-read it rather than keep
        // probing a run that has now merged. This is what tears the last timer down
        // and returns the poller to holding none.
        const watchable = await isWatchable(statePath);
        if (disposed || entries.get(statePath) !== armed)
            return;
        if (!watchable) {
            entries.delete(statePath);
            return;
        }
        schedule(statePath);
    }
    async function isWatchable(statePath) {
        try {
            return isRunPullRequestWatchable(await deps.readRunVcs(statePath));
        }
        catch {
            // An unreadable run is not a run to probe (Fallback Discipline: no guessing
            // that a PR is open on evidence we could not read).
            return false;
        }
    }
    function arm(statePath) {
        if (entries.has(statePath) || disposed)
            return;
        const entry = { attempt: 0, handle: null };
        entries.set(statePath, entry);
        schedule(statePath);
    }
    function disarm(statePath) {
        const entry = entries.get(statePath);
        if (!entry)
            return;
        if (entry.handle !== null)
            timers.clearTimeout(entry.handle);
        entries.delete(statePath);
    }
    // One notification, coalesced: read now if this run has not been read inside
    // the window, otherwise arm a single trailing read for when the window closes.
    function evaluateCoalesced(statePath) {
        if (trailingEvaluations.has(statePath))
            return;
        const sinceLast = now() - (lastEvaluatedAt.get(statePath) ?? -Infinity);
        if (sinceLast >= coalesceMs) {
            evaluate(statePath);
            return;
        }
        trailingEvaluations.set(statePath, timers.setTimeout(() => {
            trailingEvaluations.delete(statePath);
            if (disposed || !started)
                return;
            evaluate(statePath);
        }, coalesceMs - sinceLast));
    }
    // One run, re-read and reconciled against its timer. Queued per path so
    // overlapping notifications resolve in order.
    function evaluate(statePath) {
        lastEvaluatedAt.set(statePath, now());
        const previous = evaluations.get(statePath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
            if (disposed || !started)
                return;
            // An already-armed run keeps its schedule: see `noteRunChanged`.
            if (entries.has(statePath)) {
                if (!(await isWatchable(statePath)))
                    disarm(statePath);
                return;
            }
            if (await isWatchable(statePath))
                arm(statePath);
        });
        evaluations.set(statePath, next);
        void next.finally(() => {
            if (evaluations.get(statePath) === next)
                evaluations.delete(statePath);
        });
    }
    return {
        async start({ listWorkspaceRoots }) {
            started = true;
            const roots = [...listWorkspaceRoots()];
            const report = {
                roots,
                discovered: 0,
                watching: [],
                skippedStale: [],
            };
            if (disposed || roots.length === 0)
                return report;
            let runs;
            try {
                runs = await deps.listRuns(roots);
            }
            catch (error) {
                deps.logDiagnostic?.({
                    level: 'warning',
                    title: 'Sprint pull-request merge scan failed',
                    message: 'Merge state will refresh when a run changes or the app restarts.',
                    details: error instanceof Error ? error.stack ?? error.message : String(error),
                });
                return report;
            }
            report.discovered = runs.length;
            const scannedAt = now();
            for (const run of runs) {
                if (disposed)
                    break;
                if (!(await isWatchable(run.statePath)))
                    continue;
                if (isStaleForBootScan(run, scannedAt, maxAgeMs)) {
                    report.skippedStale.push(run.statePath);
                    continue;
                }
                arm(run.statePath);
                report.watching.push(run.statePath);
            }
            return report;
        },
        noteRunChanged(statePath) {
            if (!started || disposed)
                return;
            evaluateCoalesced(statePath);
        },
        watchedStatePaths() {
            return [...entries.keys()];
        },
        dispose() {
            disposed = true;
            for (const statePath of [...entries.keys()])
                disarm(statePath);
            for (const handle of trailingEvaluations.values())
                timers.clearTimeout(handle);
            trailingEvaluations.clear();
            lastEvaluatedAt.clear();
            evaluations.clear();
        },
    };
}
/**
 * Whether the startup scan leaves this run alone. Freshness is the run's own
 * `updatedAt` (the projection's, falling back to its file mtime). A run reporting
 * no timestamp at all is NOT treated as stale: the budget bound must never be the
 * reason a run with a genuinely open PR goes unwatched.
 */
export function isStaleForBootScan(run, nowMs, maxAgeMs) {
    if (!run.updatedAt)
        return false;
    const updatedAtMs = Date.parse(run.updatedAt);
    if (Number.isNaN(updatedAtMs))
        return false;
    return nowMs - updatedAtMs > maxAgeMs;
}
