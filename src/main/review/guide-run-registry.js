// Where a review's guide run actually lives (MC-1784). The renderer's run state
// used to be the only record of "the guide is working", so navigating away from
// the Reviews door and back lost it — a live run looked like no run, and a
// failure lost its reason. This module holds that state in the main process,
// which outlives every remount.
//
// It is deliberately transport-neutral: it knows nothing about terminals, MCP,
// or IPC. Whatever runs the guide records its phases here, and the review IPC
// reads them back. That is what let the producer change underneath it: the
// companion path wrote here first, the guide terminal (MC-1783) does now, and
// the review MCP tools record the brief they land — one contract of record.
const TERMINAL_PHASES = new Set(['done', 'failed']);
export class GuideRunRegistry {
    // Keyed by review id (the id the review's `.multi-code/review/<id>/` directory
    // is named for), which is also the BriefRunEvent `workspaceId`.
    runs = new Map();
    nextRunId = 1;
    // Mark a run as started, replacing any retained terminal record so a remount
    // shows the run happening now instead of the last one's failure.
    begin(reviewId, startedAt = new Date().toISOString()) {
        const runId = this.nextRunId++;
        this.runs.set(reviewId, { runId, running: true, phase: 'reading', startedAt });
        return {
            record: (phase, detail) => {
                if (this.runs.get(reviewId)?.runId !== runId)
                    return false;
                this.write(reviewId, runId, startedAt, phase, detail);
                return true;
            },
        };
    }
    // Record a phase for a run this registry never saw begin — a guide the app
    // did not start, or a transport that reports only its outcome. It adopts the
    // review's current run when there is one, so status never lies by omission.
    record(reviewId, phase, detail) {
        const existing = this.runs.get(reviewId);
        this.write(reviewId, existing?.runId ?? this.nextRunId++, existing?.startedAt ?? new Date().toISOString(), phase, detail);
    }
    // The run state of record for a review, or null when the guide has never run
    // for it in this app session. A terminal phase is retained until the next
    // begin(); it is never cleared on read.
    status(reviewId) {
        const entry = this.runs.get(reviewId);
        if (!entry)
            return null;
        const { running, phase, detail, startedAt } = entry;
        return detail ? { running, phase, detail, startedAt } : { running, phase, startedAt };
    }
    write(reviewId, runId, startedAt, phase, detail) {
        const running = !TERMINAL_PHASES.has(phase);
        this.runs.set(reviewId, detail ? { runId, running, phase, detail, startedAt } : { runId, running, phase, startedAt });
    }
}
// One registry per main process. The guide is driven from more than one place
// (the guide terminal service, the review MCP tools) and they
// all have to agree on whether a run is live, so the instance is shared rather
// than threaded through each call site. Injectable everywhere it is consumed so
// tests drive their own.
export const guideRunRegistry = new GuideRunRegistry();
